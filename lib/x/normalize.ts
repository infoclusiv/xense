import type {
  Author,
  ListInfo,
  MediaItem,
  NormalizedPost,
  PostMetrics,
  PostType,
  QuotedPost,
} from '../types';

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

function pickVideoUrl(media: Obj): string | undefined {
  const variants = media.video_info?.variants;
  if (!Array.isArray(variants)) return asString(media.media_url_https);
  const mp4s = variants
    .filter(
      (variant): variant is Obj =>
        isObject(variant) && typeof variant.url === 'string' && variant.content_type === 'video/mp4',
    )
    .sort((a, b) => asNumber(b.bitrate) - asNumber(a.bitrate));
  return asString(mp4s[0]?.url) ?? asString(media.media_url_https);
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
    const url = type === 'video' || type === 'gif' ? pickVideoUrl(media) : asString(media.media_url_https);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      type,
      url,
      thumbnail: asString(media.media_url_https),
      alt: asString(media.ext_alt_text),
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
  return {
    id: quoted.id,
    handle: quoted.author.handle,
    name: quoted.author.name,
    text: quoted.text,
    createdAt: quoted.createdAt,
    permalink: quoted.permalink,
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

  const urls = uniqueStrings(
    [...urlEntities, ...noteUrlEntities].map((entity) =>
      isObject(entity) ? asString(entity.expanded_url ?? entity.url) : undefined,
    ),
  );
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
  const isQuote = Boolean(quoted) || Boolean(legacy.is_quote_status);
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
    repostedBy: null,
    quoted,
    urls: urls.filter((url) => !url.startsWith('https://t.co/')),
    hashtags,
    mentions,
    media: extractMedia(legacy, noteEntities),
    metrics,
    permalink: buildPermalink(author.handle, id),
    collectedAt,
  };
}

export function extractTweetsFromPayload(
  payload: unknown,
  collectedAt = new Date().toISOString(),
): NormalizedPost[] {
  const entries: Obj[] = [];
  collectEntries(payload, entries);

  const tweetResults: Obj[] = [];
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
    if (post && !posts.has(post.id)) posts.set(post.id, post);
  }
  return [...posts.values()];
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
