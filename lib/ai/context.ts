import { getPostFromHistory, getSavedTranscript, saveTranscript } from '../db';
import { articleText, readArticleBlocks } from '../article';
import type { LinkPreview, MediaItem, NormalizedPost, PostArticle, QuotedPost } from '../types';
import { readXDetail, xArticleId } from '../x/detail';
import { mergeArticle, mergePostContext, toQuotedPost } from '../x/normalize';
import { postIdFromUrl } from '../x/urls';
import type { AiProvider } from './analysis';
import { webUrl, type ArticlePlacement, type ContextEvidence, type EvidenceKind, type PostEvidence } from './evidence';
import { nativeRequest, type NativeReply } from './native';
import { parseTranscription, transcriptLabel, youtubeUrl, youtubeVideoId, type Transcription } from './transcript';

const MAX_X_READS = 12;
const MAX_WEB_READS = 12;
const MAX_MEDIA_READS = 8;
export const MAX_CONTEXT_PER_POST = 10;

interface ContextOptions {
  runId: string;
  provider: AiProvider;
  model: string;
  enrich?: boolean;
  transcriptImports?: ReadonlyMap<string, Transcription>;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

interface Candidate {
  kind: Exclude<EvidenceKind, 'post'>;
  url: string;
  article?: PostArticle;
  preview?: LinkPreview;
  media?: MediaItem;
  placement?: ArticlePlacement;
  embedded?: boolean;
  youtubeId?: string;
}

function linkCandidate(url: string, preview?: LinkPreview): Candidate {
  const id = youtubeVideoId(url);
  return id ? { url: youtubeUrl(id), kind: 'video', youtubeId: id, preview }
    : { url, kind: xArticleId(url) ? 'article' : 'link', preview };
}

function articleFromPage(page: NonNullable<NativeReply['page']>): PostArticle {
  if (page.type === 'text/plain') return { url: page.url, text: page.html.trim().slice(0, 40_000) };
  const template = document.createElement('template');
  template.innerHTML = page.html;
  const root = template.content;
  const title = root.querySelector('meta[property="og:title"]')?.getAttribute('content')
    ?? root.querySelector('title, h1')?.textContent ?? undefined;
  const preview = root.querySelector('meta[property="og:description"], meta[name="description"]')?.getAttribute('content') ?? undefined;
  const articles = root.querySelectorAll('[itemprop="articleBody"], article');
  const main = [...(articles.length ? articles : root.querySelectorAll('main, [role="main"]'))]
    .sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0];
  const blocks = readArticleBlocks(main ?? root, page.url);
  const content = articleText(blocks);
  return {
    url: page.url, title, preview, blocks, blocksFromDetail: true,
    text: content.length >= 220 || (main && blocks.some(block => block.kind === 'media')) ? content || undefined : undefined,
  };
}

function candidatesOf(post: Pick<QuotedPost, 'article' | 'media' | 'urls' | 'linkPreview'>, defaultUrl?: string): Candidate[] {
  const candidates = new Map<string, Candidate>();
  const articleUrl = post.article?.url ?? defaultUrl;
  if (post.article && articleUrl) {
    candidates.set(articleUrl, { url: articleUrl, kind: 'article', article: post.article });
  }
  for (const media of post.media ?? []) {
    const kind = media.type === 'video' || media.type === 'gif' ? 'video' : 'image';
    candidates.set(media.url, { url: media.url, kind, media });
  }
  for (const url of [...(post.urls ?? []), post.linkPreview?.url]) {
    if (!url || candidates.has(url) || postIdFromUrl(url) || webUrl(url) === (articleUrl && webUrl(articleUrl))) continue;
    const candidate = linkCandidate(url, url === post.linkPreview?.url ? post.linkPreview : undefined);
    const existing = candidates.get(candidate.url);
    if (!existing || candidate.preview && !existing.preview) candidates.set(candidate.url, candidate);
  }
  return [...candidates.values()];
}

function articleCandidates(article: PostArticle, articleId: string): Candidate[] {
  const candidates: Candidate[] = [];
  const positioned = new Set<string>();
  let section: string | undefined;
  let nearby: string | undefined;
  function add(url: string, placement: ArticlePlacement, media?: MediaItem, embedded = false) {
    const canonical = webUrl(url);
    if (!canonical || canonical === (article.url && webUrl(article.url))) return;
    positioned.add(canonical);
    const candidate: Candidate = media
      ? { kind: media.type === 'photo' || media.type === 'unknown' ? 'image' : 'video', url: canonical, media }
      : linkCandidate(canonical);
    candidates.push({ ...candidate, placement, embedded });
  }
  for (const [index, block] of (article.blocks ?? []).entries()) {
    if (block.kind === 'heading') {
      section = block.text.slice(0, 160);
      nearby = undefined;
    } else if (block.kind === 'text') {
      nearby = block.text.slice(0, 420);
    } else {
      const following = article.blocks?.[index + 1];
      const placement = { articleId, section, nearby: nearby ?? (following?.kind === 'text' ? following.text.slice(0, 420) : undefined) };
      if ('media' in block) {
        const media = block.media;
        const original = article.media?.find(item => item.url === media.url || (
          (media.type === 'video' || media.type === 'gif') && item.thumbnail === media.url
        ));
        const best = original ? { ...media, ...original, alt: original.alt ?? media.alt } : media;
        add(best.url, { ...placement, caption: block.caption }, best);
      }
      if ('url' in block) add(block.url, { ...placement, caption: block.text }, undefined, block.kind === 'embed');
    }
  }
  for (const item of article.media ?? []) {
    const url = webUrl(item.url);
    if (url && !positioned.has(url)) add(url, { articleId }, item);
  }
  for (const value of article.urls ?? []) {
    const url = webUrl(value);
    if (url && !positioned.has(url)) add(url, { articleId });
  }
  return candidates.sort((left, right) => Number(right.kind === 'video' || right.kind === 'image')
    - Number(left.kind === 'video' || left.kind === 'image'));
}

function postEvidence(id: string, post?: QuotedPost, skipped = false): ContextEvidence {
  return {
    id,
    kind: 'post',
    status: post ? post.text ? 'complete' : 'partial' : skipped ? 'skipped' : 'unavailable',
    url: `https://x.com/i/status/${id}`,
    handle: post?.handle,
    createdAt: post?.createdAt,
    text: post?.text,
    method: post ? 'publicación de X' : 'publicación sin contenido recuperado',
  };
}

export async function collectAnalysisContext(
  posts: NormalizedPost[],
  options: ContextOptions,
): Promise<{ posts: NormalizedPost[]; evidence: Map<string, PostEvidence[]> }> {
  const { enrich, model, provider, signal, onProgress } = options;
  const byPost = new Map<string, PostEvidence[]>();
  const known = new Map<string, NormalizedPost>();
  const embedded = new Map<string, QuotedPost>();
  for (const post of posts) {
    if (!post.id) continue;
    known.set(post.id, mergePostContext(known.get(post.id), post));
    let quoted = post.quoted;
    for (let depth = 0; quoted && depth < 4; depth++) {
      const previous = embedded.get(quoted.id);
      if (!previous || quoted.text.length > previous.text.length
        || (quoted.media?.length ?? 0) > (previous.media?.length ?? 0)) embedded.set(quoted.id, quoted);
      quoted = quoted.quoted;
    }
  }

  const contextPosts = new Map<string, { post?: QuotedPost; skipped: boolean }>();
  const detailPosts = new Map<string, NormalizedPost>();
  const resources = new Map<string, ContextEvidence>();
  const refreshed = new Map<string, NormalizedPost>();
  const articleExtras = new Map<string, PostArticle>();
  let xReads = 0;
  let webReads = 0;
  let mediaReads = 0;
  let xLimited = false;

  async function readX(kind: 'post' | 'article', id: string) {
    if (!enrich || xLimited || xReads >= MAX_X_READS) return;
    xReads += 1;
    signal.throwIfAborted();
    onProgress(`Recuperando contexto en X · ${xReads} de hasta ${MAX_X_READS}…`);
    const reply = await readXDetail(kind, id, signal).catch(() => undefined);
    signal.throwIfAborted();
    if (reply?.limited) xLimited = true;
    for (const post of reply?.related ?? []) detailPosts.set(post.id, mergePostContext(detailPosts.get(post.id), post));
    return reply;
  }

  async function related(id: string): Promise<{ post?: QuotedPost; skipped: boolean }> {
    const cached = contextPosts.get(id);
    if (cached) return cached;
    const present = known.get(id);
    const detail = detailPosts.get(id);
    const local = detail ? mergePostContext(present, detail) : present;
    let post = local ? toQuotedPost(local) : embedded.get(id);
    if (!post?.text && !post?.article?.text && !post?.media?.length) {
      const historical = await getPostFromHistory(id).catch(() => undefined);
      signal.throwIfAborted();
      if (historical) post = toQuotedPost(historical);
    }
    const eligible = enrich && !xLimited && xReads < MAX_X_READS;
    if (!post?.text && !post?.article?.text && !post?.media?.length) {
      const detail = await readX('post', id);
      if (detail?.post) post = toQuotedPost(detail.post);
    }
    const resolved = { post, skipped: !eligible };
    contextPosts.set(id, resolved);
    return resolved;
  }

  async function readCandidate(candidate: Candidate, language?: string): Promise<ContextEvidence | undefined> {
    const url = webUrl(candidate.url);
    if (!url) return;
    const key = `${candidate.kind} ${url}`;
    const cached = resources.get(key);
    const hasNewAlt = Boolean(candidate.media?.alt && !cached?.alt);
    const hasNewArticle = Boolean(candidate.article?.text && cached?.status !== 'complete');
    const hasNewPreview = Boolean(candidate.preview?.description && !cached?.text);
    if (cached && !hasNewAlt && !hasNewArticle && !hasNewPreview) return cached;
    const resource: ContextEvidence = {
      id: cached?.id ?? `recurso-${resources.size + 1}`,
      url, kind: candidate.kind, status: 'skipped', method: 'enlace sin lectura',
    };
    const savedTranscript = candidate.kind === 'video'
      ? await getSavedTranscript(options.runId, url).catch(() => undefined)
      : undefined;
    const existingTranscript = candidate.youtubeId || savedTranscript?.complete === true ? savedTranscript : undefined;
    signal.throwIfAborted();
    if (candidate.youtubeId) {
      resource.title = candidate.preview?.title ?? 'Video de YouTube';
      resource.text = candidate.preview?.description;
      let transcript = options.transcriptImports?.get(candidate.youtubeId) ?? existingTranscript;
      if (!transcript && enrich && mediaReads < MAX_MEDIA_READS) {
        mediaReads += 1;
        onProgress(`Recuperando subtítulos de YouTube · ${mediaReads} de hasta ${MAX_MEDIA_READS}…`);
        const reply = await nativeRequest({ type: 'YOUTUBE_TRANSCRIPT', videoId: candidate.youtubeId, language }).catch(() => undefined);
        signal.throwIfAborted();
        transcript = parseTranscription(reply?.transcription ?? { status: 'unavailable' });
      }
      resource.transcription = transcript ?? parseTranscription({ status: 'skipped' });
      resource.status = transcript?.status === 'ready' ? 'partial'
        : resource.text ? 'partial' : !transcript ? 'skipped' : 'unavailable';
      resource.method = [resource.text && 'vista previa', transcriptLabel(resource.transcription)].filter(Boolean).join(' · ');
    } else if (candidate.media) {
      const { media } = candidate;
      resource.method = media.alt ? 'texto alternativo del autor' : 'archivo sin lectura';
      resource.status = media.alt ? 'partial' : 'skipped';
      resource.alt = media.alt;
      if (existingTranscript) {
        resource.transcription = existingTranscript;
        resource.status = 'partial';
        resource.method = transcriptLabel(existingTranscript);
      }
      if (cached && (cached.visual || cached.moments?.length || cached.transcription)) {
        cached.alt = media.alt;
        cached.method += ' · texto alternativo';
        return cached;
      }
      if (!cached && enrich && mediaReads < MAX_MEDIA_READS && media.type !== 'unknown') {
        mediaReads += 1;
        onProgress(`Leyendo multimedia · ${mediaReads} de hasta ${MAX_MEDIA_READS}…`);
        const request = {
          type: 'ANALYZE_MEDIA', provider, model, url: media.analysisUrl ?? url, kind: media.type, durationMs: media.durationMs,
          publicArticle: Boolean(candidate.placement), originalUrl: url, skipTranscription: Boolean(existingTranscript),
        };
        let reply = await nativeRequest(request, resource.kind === 'video' ? { signal, onProgress } : undefined)
          .catch(() => undefined);
        signal.throwIfAborted();
        const transcription = reply?.media?.transcription;
        if (!reply?.media?.description && !reply?.media?.moments?.length && media.thumbnail && media.thumbnail !== url) {
          const thumbnail = await nativeRequest({ ...request, url: media.thumbnail, kind: 'photo' }).catch(() => undefined);
          signal.throwIfAborted();
          if (thumbnail?.media?.description) reply = { ...thumbnail, media: { ...thumbnail.media, thumbnailOnly: true } };
        }
        const decoded = reply?.media;
        const hasVision = Boolean(decoded?.description || decoded?.moments?.length);
        if (resource.kind === 'video' && !existingTranscript) {
          const retrieved = parseTranscription(transcription ?? { status: 'audio-unavailable' });
          resource.transcription = retrieved.status === 'ready' || !savedTranscript ? retrieved
            : { ...savedTranscript, complete: false };
        }
        if (hasVision || resource.transcription?.status === 'ready') {
          const visual = decoded?.thumbnailOnly ? 'miniatura'
            : decoded?.frames.length ? `fotogramas en ${decoded.frames.join(', ')} s`
              : 'imagen analizada con visión';
          resource.method = [
            hasVision && visual,
            resource.transcription && transcriptLabel(resource.transcription),
            media.alt && 'texto alternativo',
          ].filter(Boolean).join(' · ');
          resource.visual = decoded?.description;
          resource.moments = decoded?.moments;
          resource.status = media.type === 'photo' && !decoded?.thumbnailOnly && !decoded?.frames.length ? 'complete' : 'partial';
        } else if (!media.alt) {
          resource.status = 'unavailable';
          resource.method = 'descarga o análisis visual no disponible';
        }
        if (resource.transcription && !resource.method.includes(transcriptLabel(resource.transcription))) {
          resource.method += ' · ' + transcriptLabel(resource.transcription);
        }
      } else if (savedTranscript && !existingTranscript) {
        resource.transcription = { ...savedTranscript, complete: false };
        resource.status = 'partial';
        resource.method = transcriptLabel(resource.transcription);
      }
    } else {
      const articleId = xArticleId(url);
      const metadata = candidate.article ?? candidate.preview;
      const preview = candidate.article?.preview ?? candidate.preview?.description;
      let article = candidate.article;
      resource.title = metadata?.title;
      resource.text = article?.text ?? preview;
      resource.status = article?.text && (!articleId || article.blocksFromDetail) ? 'complete'
        : metadata ? 'partial' : 'skipped';
      resource.method = article?.text ? 'cuerpo del Artículo de X'
        : metadata ? 'vista previa' : 'enlace sin lectura';
      if (!cached && articleId && !article?.blocksFromDetail && enrich && !xLimited && xReads < MAX_X_READS) {
        const reply = await readX('article', articleId);
        if (reply?.article) {
          article = mergeArticle(article, reply.article);
          resource.text = article?.text ?? resource.text;
          resource.title = article?.title ?? resource.title;
          resource.status = article?.text ? 'complete' : 'partial';
          resource.method = 'cuerpo del Artículo de X';
        } else if (!metadata) {
          resource.status = 'unavailable';
          resource.method = 'Artículo de X sin cuerpo accesible';
        }
      } else if (resource.status !== 'complete' && !cached && !articleId && !postIdFromUrl(url) && enrich && webReads < MAX_WEB_READS) {
        webReads += 1;
        onProgress(`Leyendo enlaces · ${webReads} de hasta ${MAX_WEB_READS}…`);
        const reply = await nativeRequest({ type: 'READ_PUBLIC_PAGE', url }).catch(() => undefined);
        signal.throwIfAborted();
        const page = reply?.page && articleFromPage(reply.page);
        if (page) article = page;
        resource.url = reply?.page ? webUrl(reply.page.url) ?? url : url;
        resource.title = page ? page.title ?? resource.title ?? (page.blocks?.length ? new URL(url).hostname : undefined) : resource.title;
        resource.text = page ? page.text ?? page.preview ?? resource.text : resource.text;
        resource.status = page && page.text ? 'complete'
          : resource.text || resource.title ? 'partial' : 'unavailable';
        resource.method = page && page.text ? 'texto extraído de la página'
          : page?.blocks?.some(block => block.kind === 'media') ? 'página con adjuntos recuperados'
            : resource.status === 'partial' ? 'vista previa' : 'página sin texto accesible';
      }
      if (article) articleExtras.set(url, mergeArticle(articleExtras.get(url), article) ?? article);
      if (articleId && article?.text && !article.blocksFromDetail) resource.method += ' · adjuntos del cuerpo sin verificar';
    }
    if (!existingTranscript && resource.transcription?.status === 'ready' && resource.transcription.origin !== 'imported') {
      await saveTranscript(options.runId, url, resource.transcription).catch(() => undefined);
    }
    const stored = cached ? Object.assign(cached, resource) : resource;
    resources.set(key, stored);
    return stored;
  }

  const ordered = [...known.values()].sort((a, b) => Number(b.text.length < 100) - Number(a.text.length < 100));
  for (const captured of ordered) {
    signal.throwIfAborted();
    let post = captured;
    const missingParent = post.isReply && !post.replyToPostId;
    const missingQuote = post.isQuote && !post.quotedPostId && !post.quoted;
    if (missingParent || missingQuote) {
      const detail = await readX('post', post.id);
      if (detail?.post) {
        post = mergePostContext(post, detail.post);
        refreshed.set(post.id, post);
      }
    }

    const list: PostEvidence[] = [];
    const attachments: Array<{ candidate: Candidate; relation: string; depth: number }> = [];
    let truncated = false;
    const append = (source: ContextEvidence, relation: string, placement?: ArticlePlacement) => {
      if (list.some(item => item.source.id === source.id && item.relation === relation
        && item.placement?.section === placement?.section && item.placement?.caption === placement?.caption)) return;
      if (list.length >= MAX_CONTEXT_PER_POST) {
        truncated = true;
        return;
      }
      list.push({ source, relation, placement });
    };
    const attach = (from: QuotedPost, relation: string) => {
      for (const candidate of candidatesOf(from, from.permalink)) attachments.push({ candidate, relation, depth: 0 });
    };
    attach(toQuotedPost(post), 'adjunto del post');

    const relations = new Map<string, string>();
    const link = (id: string | undefined, relation: string) => {
      if (!id || !/^\d{1,30}$/.test(id) || id === post.id) return;
      const previous = relations.get(id);
      if (!previous) relations.set(id, relation);
      else if (relation === 'cita a') relations.set(id, `${previous} y cita a`);
    };
    link(post.replyToPostId, 'responde a');
    link(post.quotedPostId ?? post.quoted?.id, 'cita a');
    link(post.conversationId, 'raíz de la conversación');
    if (post.isRepost) link(post.originalPostId ?? postIdFromUrl(post.permalink), 'repost de');
    for (const url of post.urls) link(postIdFromUrl(url), 'enlaza otro post');
    if (relations.size > 4) truncated = true;

    for (const [id, relation] of [...relations].slice(0, 4)) {
      const result = await related(id);
      append(postEvidence(id, result.post, result.skipped), relation);
      if (result.post) attach(result.post, `adjunto de ${id}`);
      const nested = result.post?.quotedPostId ?? result.post?.quoted?.id;
      if (nested && nested !== post.id && !relations.has(nested) && /^\d{1,30}$/.test(nested)) {
        const inner = await related(nested);
        append(postEvidence(nested, inner.post, inner.skipped), `cita de ${id}`);
        if (inner.post) attach(inner.post, `adjunto de ${nested}`);
      }
    }
    if (post.isReply && !post.replyToPostId) {
      append({
        id: `respuesta-${post.id}`, kind: 'post', status: 'unavailable', method: 'post padre sin ID',
        handle: post.replyToHandle,
      }, 'responde a');
    }
    if (post.isQuote && !post.quotedPostId && !post.quoted) {
      append({ id: `cita-${post.id}`, kind: 'post', status: 'unavailable', method: 'cita sin ID' }, 'cita a');
    }

    const expandedArticles = new Set<string>();
    for (let index = 0; index < attachments.length; index++) {
      if (list.length >= MAX_CONTEXT_PER_POST) {
        truncated = true;
        break;
      }
      const { candidate, relation, depth } = attachments[index]!;
      const linkedId = candidate.placement && postIdFromUrl(candidate.url);
      if (linkedId) {
        if (linkedId !== post.id) {
          const linked = await related(linkedId);
          append(postEvidence(linkedId, linked.post, linked.skipped), relation, candidate.placement);
        }
        continue;
      }
      const source = await readCandidate(candidate, post.lang);
      if (!source) continue;
      append(source, relation, candidate.placement);
      const canonicalUrl = webUrl(candidate.url);
      const extra = canonicalUrl && articleExtras.get(canonicalUrl);
      if (depth === 0 && canonicalUrl && extra && !expandedArticles.has(canonicalUrl)) {
        expandedArticles.add(canonicalUrl);
        attachments.splice(index + 1, 0, ...articleCandidates(extra, source.id).map(nested => ({
          candidate: nested, depth: depth + 1,
          relation: `${nested.media ? 'adjunto' : nested.embedded ? 'contenido incrustado' : 'enlace'} de ${source.id}`,
        })));
      }
    }
    if (truncated) {
      list.push({
        relation: 'otras referencias',
        source: { id: `límite-${post.id}`, kind: 'link', status: 'skipped', method: 'límite de fuentes por post' },
      });
    }
    if (list.length) byPost.set(post.id, list);
  }
  return { posts: posts.map(post => refreshed.get(post.id) ?? known.get(post.id) ?? post), evidence: byPost };
}
