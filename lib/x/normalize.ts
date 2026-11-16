import type {
  ArticleBlock,
  Author,
  ListInfo,
  MediaItem,
  NormalizedPost,
  PostArticle,
  PostMetrics,
  PostType,
  QuotedPost,
} from '../types';
import { articleText, articleUrl, MAX_ARTICLE_BLOCKS } from '../article';
import { postIdFromUrl } from './urls';

type Obj = Record<string, any>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function collectEntries(node: unknown, output: Obj[], depth = 0): void {
  if (depth > 30) return;
  if (Array.isArray(node)) {
    for (const item of node) collectEntries(item, output, depth + 1);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'entries' || key === 'items') && Array.isArray(value)) {
      for (const entry of value) {
        if (isObject(entry)) output.push(entry);
      }
    }
    collectEntries(value, output, depth + 1);
  }
}

function collectTweetResults(node: unknown, output: Obj[], depth = 0): void {
  if (depth > 30) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTweetResults(item, output, depth + 1);
    return;
  }
  if (!isObject(node)) return;
  if (isObject(node.tweet_results) && isObject(node.tweet_results.result)) {
    output.push(node.tweet_results.result);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'tweet_results') continue;
    collectTweetResults(value, output, depth + 1);
  }
}

function isPromotedEntry(entry: Obj): boolean {
  const entryId = asString(entry.entryId ?? entry.entry_id) ?? '';
  if (/^(promoted|ads?)[-_]/i.test(entryId) || /promoted/i.test(entryId)) return true;
  const content = entry.content;
  if (isObject(content)) {
    if (content.promotedMetadata || content.promoted_metadata) return true;
    const itemContent = content.itemContent ?? content.item_content;
    if (isObject(itemContent) && (itemContent.promotedMetadata || itemContent.promoted_metadata)) {
      return true;
    }
  }
  const directItemContent = entry.itemContent ?? entry.item_content;
  if (
    isObject(directItemContent) &&
    (directItemContent.promotedMetadata || directItemContent.promoted_metadata)
  ) {
    return true;
  }
  return Boolean(entry.promotedMetadata || entry.promoted_metadata);
}

function unwrapTweet(result: Obj): Obj | null {
  let current: Obj | null = result;
  for (let i = 0; i < 4; i += 1) {
    if (!current) return null;
    const typename = asString(current.__typename);
    if (typename === 'TweetWithVisibilityResults' && isObject(current.tweet)) {
      current = current.tweet;
      continue;
    }
    if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') return null;
    break;
  }
  return current;
}

function extractAuthor(result: Obj): Author {
  const userResult =
    result.core?.user_results?.result ??
    result.core?.user_result?.result ??
    result.user_results?.result ??
    result.user_result?.result;

  const core = isObject(userResult?.core) ? userResult.core : undefined;
  const legacy = isObject(userResult?.legacy) ? userResult.legacy : undefined;

  return {
    id: asString(userResult?.rest_id ?? userResult?.id_str),
    handle: asString(core?.screen_name ?? legacy?.screen_name) ?? 'desconocido',
    name: asString(core?.name ?? legacy?.name) ?? 'Desconocido',
    verified: Boolean(userResult?.is_blue_verified ?? legacy?.verified),
  };
}

function videoVariants(media: Obj): Obj[] {
  const variants = media.video_info?.variants;
  if (!Array.isArray(variants)) return [];
  return variants
    .filter(
      (variant): variant is Obj =>
        isObject(variant) && typeof variant.url === 'string' && variant.content_type === 'video/mp4',
    )
    .sort((a, b) => asNumber(b.bitrate) - asNumber(a.bitrate));
}

function extractMedia(legacy: Obj, noteEntities: Obj | undefined): MediaItem[] {
  const rawMedia =
    legacy.extended_entities?.media ?? legacy.entities?.media ?? noteEntities?.media ?? [];
  if (!Array.isArray(rawMedia)) return [];

  const items: MediaItem[] = [];
  const seen = new Set<string>();

  for (const media of rawMedia) {
    if (!isObject(media)) continue;
    const rawType = asString(media.type);
    const type: MediaItem['type'] =
      rawType === 'photo'
        ? 'photo'
        : rawType === 'animated_gif'
          ? 'gif'
          : rawType === 'video'
            ? 'video'
            : 'unknown';
    const variants = type === 'video' || type === 'gif' ? videoVariants(media) : [];
    const url = asString(variants[0]?.url) ?? asString(media.media_url_https);
    const smaller = variants.find(variant => asNumber(variant.bitrate) <= 800_000);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      type,
      url,
      thumbnail: asString(media.media_url_https),
      alt: asString(media.ext_alt_text),
      analysisUrl: smaller?.url !== url ? asString(smaller?.url) : undefined,
      ...(asNumber(media.video_info?.duration_millis) > 0
        ? { durationMs: asNumber(media.video_info.duration_millis) }
        : {}),
    });
  }

  return items;
}

function extractQuoted(result: Obj, collectedAt: string, depth: number): QuotedPost | null {
  if (depth >= 4) return null;
  const quotedResult =
    result.quoted_status_result?.result ?? result.legacy?.quoted_status_result?.result;
  if (!isObject(quotedResult)) return null;
  const quoted = normalizeTweetResult(quotedResult, collectedAt, depth + 1);
  if (!quoted) return null;
  return toQuotedPost(quoted);
}

export function toQuotedPost(quoted: NormalizedPost): QuotedPost {
  return {
    id: quoted.id,
    handle: quoted.author.handle,
    name: quoted.author.name,
    text: quoted.text,
    createdAt: quoted.createdAt,
    permalink: quoted.permalink,
    media: quoted.media,
    urls: quoted.urls,
    article: quoted.article,
    linkPreview: quoted.linkPreview,
    quoted: quoted.quoted,
    quotedPostId: quoted.quotedPostId,
    replyToPostId: quoted.replyToPostId,
  };
}

function extractArticle(result: Obj): PostArticle | undefined {
  const article = result.article?.article_results?.result ?? result.article?.article_result?.result;
  if (!isObject(article)) return;
  const id = asString(article.rest_id ?? article.id);
  const title = asString(article.title);
  const preview = asString(article.preview_text ?? article.description);
  const url = id && /^\d+$/.test(id) ? `https://x.com/i/article/${id}` : undefined;
  const baseUrl = url ?? 'https://x.com/';
  const mediaById = new Map<string, MediaItem>();
  const rawMedia = Array.isArray(article.media_entities) ? article.media_entities : [];
  for (const record of rawMedia) {
    const mediaId = asString(record?.media_id ?? record?.id ?? record?.media_key);
    const media = extractArticleMedia(record, baseUrl);
    if (mediaId && media) mediaById.set(mediaId, media);
  }
  const entities = article.content_state?.entityMap;
  const entitiesById = new Map<string, ArticleBlock[]>();
  for (const [index, entry] of Object.entries(isObject(entities) ? entities : {})) {
    if (!isObject(entry)) continue;
    const entity = entry.value ?? entry;
    const data = entity?.data;
    if (!isObject(data)) continue;
    const items = Array.isArray(data.mediaItems) ? data.mediaItems : [data];
    const linkedMedia = items.flatMap(item => {
      const mediaId = asString(item?.mediaId ?? item?.media_id);
      const media = (mediaId && mediaById.get(mediaId)) || extractArticleMedia(item, baseUrl);
      return media ? [media] : [];
    });
    const target = articleUrl(asString(data.url ?? data.href ?? data.tweetUrl), baseUrl);
    const tweetId = asString(data.tweetId ?? data.tweet_id);
    const link = target ?? (tweetId && /^\d+$/.test(tweetId) ? `https://x.com/i/status/${tweetId}` : undefined);
    const blocks: ArticleBlock[] = linkedMedia.map(media => ({
      kind: 'media', media, caption: asString(data.caption),
    }));
    if (link && !linkedMedia.some(media => media.url === link)) {
      blocks.push({ kind: tweetId || postIdFromUrl(link) ? 'embed' : 'link', url: link, text: asString(data.title) });
    }
    if (blocks.length) entitiesById.set(asString(entry.key) ?? index, blocks);
  }
  const blocks: ArticleBlock[] = [];
  const rawBlocks = Array.isArray(article.content_state?.blocks) ? article.content_state.blocks : [];
  for (const block of rawBlocks) {
    const text = asString(block?.text);
    if (text) blocks.push({ kind: /^header/.test(block.type) ? 'heading' : 'text', text: text.slice(0, 1600) });
    for (const range of Array.isArray(block?.entityRanges) ? block.entityRanges : []) {
      for (const item of entitiesById.get(String(range?.key)) ?? []) {
        blocks.push(item);
        if (blocks.length >= MAX_ARTICLE_BLOCKS) break;
      }
      if (blocks.length >= MAX_ARTICLE_BLOCKS) break;
    }
    if (blocks.length >= MAX_ARTICLE_BLOCKS) break;
  }
  const text = articleText(blocks) || asString(article.text)?.slice(0, 40_000);
  const flat = [...entitiesById.values()].flat();
  const urls = uniqueStrings(flat.flatMap(block => 'url' in block ? [block.url] : []));
  const cover = extractArticleMedia(article.cover_media, baseUrl);
  const media = mergeMedia(cover ? [cover] : [], [
    ...mediaById.values(), ...flat.flatMap(block => block.kind === 'media' ? [block.media] : []),
  ]);
  if (title || preview || text || url || blocks.length) return { title, preview, text, url, urls, media, blocks };
}

function extractArticleMedia(value: unknown, baseUrl: string): MediaItem | undefined {
  if (!isObject(value)) return;
  const info = value.media_info ?? value.mediaInfo ?? value;
  const rawVariants = info.variants ?? info.video_info?.variants;
  const variants = Array.isArray(rawVariants) ? rawVariants.filter(variant =>
    isObject(variant) && articleUrl(asString(variant.url), baseUrl)
    && (/video\/(mp4|webm)/i.test(variant.content_type ?? variant.contentType ?? '')
      || /\.(mp4|webm)(?:[?#]|$)/i.test(variant.url)),
  ).sort((a, b) => asNumber(b.bitrate) - asNumber(a.bitrate)) : [];
  const thumbnail = articleUrl(asString(info.preview_image_url ?? info.original_img_url ?? info.media_url_https), baseUrl);
  const direct = articleUrl(asString(info.url ?? info.src), baseUrl);
  const mime = asString(info.type ?? info.__typename ?? value.mediaCategory) ?? '';
  const declaredGif = /gif/i.test(mime) || /\.gif(?:[?#]|$)/i.test(direct ?? thumbnail ?? '');
  const declaredVideo = variants.length > 0 || /video/i.test(mime) || /\.(mp4|webm)(?:[?#]|$)/i.test(direct ?? '');
  if (!thumbnail && !declaredGif && !declaredVideo && !/image|photo/i.test(mime)) return;
  const url = articleUrl(asString(variants[0]?.url), baseUrl) ?? direct ?? thumbnail;
  if (!url) return;
  const smaller = variants.find(variant => asNumber(variant.bitrate) <= 800_000);
  const durationMs = asNumber(info.duration_millis ?? info.duration_ms ?? info.video_info?.duration_millis);
  return {
    type: declaredGif ? 'gif' : declaredVideo ? 'video' : 'photo',
    url, thumbnail, alt: asString(info.alt_text ?? info.ext_alt_text ?? value.alt_text),
    durationMs: durationMs || undefined,
    analysisUrl: smaller && smaller.url !== url ? articleUrl(smaller.url, baseUrl) : undefined,
  };
}

function buildPermalink(handle: string, id: string): string {
  if (handle && handle !== 'desconocido') {
    return `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`;
  }
  return `https://x.com/i/web/status/${encodeURIComponent(id)}`;
}

export function normalizeTweetResult(
  input: unknown,
  collectedAt: string,
  depth = 0,
): NormalizedPost | null {
  if (depth > 4 || !isObject(input)) return null;
  const result = unwrapTweet(input);
  if (!result) return null;

  const legacy = isObject(result.legacy) ? result.legacy : isObject(result.tweet?.legacy) ? result.tweet.legacy : null;
  if (!legacy) return null;

  const id = asString(result.rest_id ?? legacy.id_str ?? result.tweet?.rest_id);
  const createdAtRaw = asString(legacy.created_at ?? result.created_at);
  if (!id || !createdAtRaw) return null;
  const createdAtMs = Date.parse(createdAtRaw);
  if (!Number.isFinite(createdAtMs)) return null;
  const createdAt = new Date(createdAtMs).toISOString();

  const author = extractAuthor(result);

  const retweetResult = legacy.retweeted_status_result?.result ?? result.retweeted_status_result?.result;
  if (isObject(retweetResult)) {
    const original = normalizeTweetResult(retweetResult, collectedAt, depth + 1);
    if (original) {
      return {
        ...original,
        id,
        createdAt,
        originalCreatedAt: original.createdAt,
        originalPostId: original.originalPostId ?? original.id,
        type: 'repost',
        isRepost: true,
        repostedBy: author.handle !== 'desconocido' ? author : null,
        collectedAt,
      };
    }
  }

  const noteResult = result.note_tweet?.note_tweet_results?.result;
  const noteText = isObject(noteResult) ? asString(noteResult.text) : undefined;
  const text = noteText ?? asString(legacy.full_text) ?? asString(legacy.text) ?? '';
  const noteEntities = isObject(noteResult?.entity_set) ? noteResult.entity_set : undefined;
  const entities = isObject(legacy.entities) ? legacy.entities : {};
  const urlEntities = Array.isArray(entities.urls) ? entities.urls : [];
  const noteUrlEntities = Array.isArray(noteEntities?.urls) ? noteEntities.urls : [];
  const hashtagEntities = Array.isArray(entities.hashtags) ? entities.hashtags : [];
  const noteHashtagEntities = Array.isArray(noteEntities?.hashtags) ? noteEntities.hashtags : [];
  const mentionEntities = Array.isArray(entities.user_mentions) ? entities.user_mentions : [];
  const noteMentionEntities = Array.isArray(noteEntities?.user_mentions) ? noteEntities.user_mentions : [];

  const cardBindings = result.card?.legacy?.binding_values;
  const card = (key: string) => Array.isArray(cardBindings)
    ? asString(cardBindings.find(binding => binding?.key === key)?.value?.string_value)
    : undefined;
  const cardUrl = card('card_url');
  const cardTitle = card('title');
  const cardDescription = card('description');
  const urls = uniqueStrings([
    ...[...urlEntities, ...noteUrlEntities].map((entity) =>
      isObject(entity) ? asString(entity.expanded_url ?? entity.url) : undefined,
    ),
    cardUrl,
  ]);
  const hashtags = uniqueStrings(
    [...hashtagEntities, ...noteHashtagEntities].map((entity) =>
      isObject(entity) ? asString(entity.text) : undefined,
    ),
  );
  const mentions = uniqueStrings(
    [...mentionEntities, ...noteMentionEntities].map((entity) =>
      isObject(entity) ? asString(entity.screen_name) : undefined,
    ),
  );

  const isReply = Boolean(
    legacy.in_reply_to_status_id_str ?? legacy.in_reply_to_user_id_str ?? legacy.in_reply_to_screen_name,
  );
  const replyToHandle = asString(legacy.in_reply_to_screen_name);
  const quoted = extractQuoted(result, collectedAt, depth);
  const quoteUrl = asString(legacy.quoted_status_permalink?.expanded);
  const quotedPostId = quoted?.id ?? asString(legacy.quoted_status_id_str)
    ?? (quoteUrl ? postIdFromUrl(quoteUrl) : undefined);
  const isQuote = Boolean(quotedPostId || legacy.is_quote_status);
  const type: PostType = isReply ? 'reply' : isQuote ? 'quote' : 'original';

  const metrics: PostMetrics = {
    likes: asNumber(legacy.favorite_count),
    reposts: asNumber(legacy.retweet_count),
    replies: asNumber(legacy.reply_count),
    quotes: asNumber(legacy.quote_count),
    views: asNumber(result.views?.count ?? legacy.views_count),
    bookmarks: asNumber(legacy.bookmark_count),
  };

  return {
    id,
    createdAt,
    author,
    text: text.trim(),
    lang: asString(legacy.lang),
    type,
    isReply,
    isRepost: false,
    isQuote,
    replyToHandle,
    replyToPostId: asString(legacy.in_reply_to_status_id_str),
    conversationId: asString(legacy.conversation_id_str),
    repostedBy: null,
    quoted,
    quotedPostId,
    article: extractArticle(result),
    linkPreview: cardUrl && (cardTitle || cardDescription)
      ? { url: cardUrl, title: cardTitle, description: cardDescription }
      : undefined,
    urls: urls.filter((url) => !url.startsWith('https://t.co/')),
    hashtags,
    mentions,
    media: extractMedia(legacy, noteEntities),
    metrics,
    permalink: buildPermalink(author.handle, id),
    collectedAt,
    captureSource: 'graphql',
  };
}

export function extractTweetsFromPayload(
  payload: unknown,
  collectedAt = new Date().toISOString(),
): NormalizedPost[] {
  const entries: Obj[] = [];
  collectEntries(payload, entries);

  const tweetResults: Obj[] = [];
  if (isObject(payload)) {
    const direct = payload.data?.tweetResult?.result ?? payload.data?.tweet_result?.result;
    if (isObject(direct)) tweetResults.push(direct);
  }
  for (const entry of entries) {
    if (isPromotedEntry(entry)) continue;
    collectTweetResults(entry, tweetResults);
  }

  if (tweetResults.length === 0) {
    collectTweetResults(payload, tweetResults);
  }

  const posts = new Map<string, NormalizedPost>();
  for (const result of tweetResults) {
    const post = normalizeTweetResult(result, collectedAt);
    if (post) posts.set(post.id, mergePostContext(posts.get(post.id), post));
  }
  return [...posts.values()];
}

function mergeMedia(previous: MediaItem[], current: MediaItem[]): MediaItem[] {
  const media = new Map(previous.map(item => [item.url, item]));
  for (const item of current) {
    const stored = media.get(item.url);
    media.set(item.url, {
      ...item,
      thumbnail: item.thumbnail ?? stored?.thumbnail,
      alt: item.alt ?? stored?.alt,
      durationMs: item.durationMs ?? stored?.durationMs,
      analysisUrl: item.analysisUrl ?? stored?.analysisUrl,
    });
  }
  return [...media.values()];
}

export function mergeArticle(previous?: PostArticle, current?: PostArticle): PostArticle | undefined {
  if (!previous || !current || (previous.url && current.url && previous.url !== current.url)) {
    return current ?? previous;
  }
  return {
    url: current.url ?? previous.url,
    title: current.title ?? previous.title,
    preview: current.preview ?? previous.preview,
    text: current.text ?? previous.text,
    urls: uniqueStrings([...(previous.urls ?? []), ...(current.urls ?? [])]),
    media: mergeMedia(previous.media ?? [], current.media ?? []),
    blocks: current.blocksFromDetail || (!previous.blocksFromDetail && (current.blocks?.length ?? 0) > (previous.blocks?.length ?? 0))
      ? current.blocks
      : previous.blocks,
    blocksFromDetail: previous.blocksFromDetail || current.blocksFromDetail,
  };
}

function mergeQuote(previous?: QuotedPost | null, current?: QuotedPost | null): QuotedPost | null | undefined {
  if (!previous || !current || previous.id !== current.id) return current ?? previous;
  return {
    ...previous,
    ...current,
    handle: current.handle && current.handle !== 'desconocido' ? current.handle : previous.handle ?? current.handle,
    name: current.name && current.name !== 'Desconocido' ? current.name : previous.name ?? current.name,
    createdAt: current.createdAt ?? previous.createdAt,
    permalink: current.permalink ?? previous.permalink,
    text: current.text.length >= previous.text.length ? current.text : previous.text,
    urls: uniqueStrings([...(previous.urls ?? []), ...(current.urls ?? [])]),
    media: mergeMedia(previous.media ?? [], current.media ?? []),
    article: mergeArticle(previous.article, current.article),
    linkPreview: current.linkPreview ?? previous.linkPreview,
    quoted: mergeQuote(previous.quoted, current.quoted),
    quotedPostId: current.quotedPostId ?? previous.quotedPostId,
    replyToPostId: current.replyToPostId ?? previous.replyToPostId,
  };
}

export function mergePostContext(previous: NormalizedPost | undefined, current: NormalizedPost): NormalizedPost {
  if (!previous) return current;
  const authoritative = current.captureSource === 'graphql' && previous.captureSource !== 'graphql'
    || previous.author.handle === 'desconocido' && current.author.handle !== 'desconocido';
  const post = authoritative ? current : previous;
  return {
    ...post,
    author: post.author.handle === 'desconocido' ? previous.author : post.author,
    text: current.text.length >= previous.text.length ? current.text : previous.text,
    isReply: post.isReply || Boolean(previous.replyToPostId ?? current.replyToPostId),
    isQuote: post.isQuote || Boolean(previous.quotedPostId ?? current.quotedPostId),
    replyToHandle: current.replyToHandle ?? previous.replyToHandle,
    replyToPostId: current.replyToPostId ?? previous.replyToPostId,
    conversationId: current.conversationId ?? previous.conversationId,
    originalPostId: current.originalPostId ?? previous.originalPostId,
    originalCreatedAt: current.originalCreatedAt ?? previous.originalCreatedAt,
    repostedBy: current.repostedBy ?? previous.repostedBy,
    quoted: mergeQuote(previous.quoted, current.quoted),
    quotedPostId: current.quotedPostId ?? previous.quotedPostId,
    article: mergeArticle(previous.article, current.article),
    linkPreview: current.linkPreview ?? previous.linkPreview,
    urls: uniqueStrings([...previous.urls, ...current.urls]),
    media: mergeMedia(previous.media, current.media),
  };
}

function firstUserHandle(obj: Obj): string | undefined {
  const userResult =
    obj.user_results?.result ?? obj.user_result?.result ?? obj.user?.legacy ?? obj.user;
  return asString(
    userResult?.core?.screen_name ?? userResult?.legacy?.screen_name ?? userResult?.screen_name,
  );
}

export function extractListsFromPayload(
  payload: unknown,
  nowIso = new Date().toISOString(),
): ListInfo[] {
  const lists = new Map<string, ListInfo>();

  const walk = (node: unknown, depth = 0): void => {
    if (depth > 30) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!isObject(node)) return;

    const id = asString(node.id_str ?? node.rest_id ?? node.id);
    const name = asString(node.name);
    const typename = asString(node.__typename);
    const memberCountRaw = node.member_count ?? node.members_count;
    const hasMemberCount = typeof memberCountRaw === 'number';
    if (id && name && (hasMemberCount || typename === 'List')) {
      const list: ListInfo = {
        id,
        name,
        memberCount: hasMemberCount ? Number(memberCountRaw) : undefined,
        ownerHandle: firstUserHandle(node),
        url: `https://x.com/i/lists/${id}`,
        source: 'graphql',
        updatedAt: nowIso,
      };
      const previous = lists.get(id);
      if (!previous || (list.memberCount ?? 0) >= (previous.memberCount ?? 0)) {
        lists.set(id, list);
      }
    }

    for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(payload);
  return [...lists.values()];
}
