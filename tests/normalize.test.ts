import { describe, expect, it } from 'vitest';
import { extractListsFromPayload, extractTweetsFromPayload, mergePostContext, normalizeTweetResult } from '../lib/x/normalize';

const COLLECTED_AT = '2026-11-13T10:00:00.000Z';

function originalTweet() {
  return {
    __typename: 'Tweet',
    rest_id: '123',
    core: {
      user_results: {
        result: {
          rest_id: 'u1',
          is_blue_verified: true,
          core: { screen_name: 'ana', name: 'Ana Pérez' },
        },
      },
    },
    legacy: {
      created_at: 'Thu Nov 12 14:30:00 +0000 2026',
      full_text: 'Hola mundo #xense, gracias @bob',
      lang: 'es',
      favorite_count: 12,
      retweet_count: 3,
      reply_count: 1,
      quote_count: 2,
      bookmark_count: 1,
      entities: {
        hashtags: [{ text: 'xense' }],
        urls: [
          {
            url: 'https://t.co/abc',
            expanded_url: 'https://example.com/nota',
          },
        ],
        user_mentions: [{ screen_name: 'bob' }],
      },
      extended_entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/media/foto.jpg',
            ext_alt_text: 'Una foto',
          },
        ],
      },
    },
  };
}

function entry(entryId: string, result: unknown) {
  return {
    entryId,
    content: {
      itemContent: {
        tweet_results: { result },
      },
    },
  };
}

function payloadWith(entries: unknown[]) {
  return {
    data: {
      search_by_raw_query: {
        timeline: {
          instructions: [{ type: 'TimelineAddEntries', entries }],
        },
      },
    },
  };
}

describe('extractTweetsFromPayload', () => {
  it('conserva padre, raíz, cita y Artículo de X en una captura de detalle', () => {
    const original = originalTweet();
    const reply = {
      ...original,
      rest_id: '200',
      legacy: {
        ...original.legacy,
        in_reply_to_status_id_str: '65',
        conversation_id_str: '40',
        quoted_status_id_str: '123',
      },
      quoted_status_result: {
        result: {
          ...original,
          article: { article_results: { result: {
            rest_id: '999',
            title: 'Informe',
            content_state: { blocks: [{ text: 'Primera sección' }, { text: 'Segunda sección' }] },
          } } },
        },
      },
    };
    const [post] = extractTweetsFromPayload({ data: { tweetResult: { result: reply } } }, COLLECTED_AT);
    expect(post).toMatchObject({
      replyToPostId: '65', conversationId: '40', quotedPostId: '123', isReply: true, isQuote: true,
      quoted: {
        urls: ['https://example.com/nota'],
        media: [{ alt: 'Una foto' }],
        article: {
          title: 'Informe', url: 'https://x.com/i/article/999', text: 'Primera sección\n\nSegunda sección',
        },
      },
    });
    expect(normalizeTweetResult({ ...reply, quoted_status_result: undefined }, COLLECTED_AT))
      .toMatchObject({ quotedPostId: '123', quoted: null, isQuote: true });
  });

  it('completa una captura anterior sin perder el autor ni los adjuntos ya disponibles', () => {
    const original = originalTweet();
    const full = normalizeTweetResult(original, COLLECTED_AT)!;
    const initial = {
      ...full, text: 'Hola', media: [], captureSource: 'dom' as const,
      replyToPostId: '42', conversationId: '41',
    };
    const merged = mergePostContext(initial, full);
    expect(merged).toMatchObject({ text: full.text, media: full.media, replyToPostId: '42', conversationId: '41' });
    expect(mergePostContext(merged, initial)).toEqual(merged);
  });

  it('conserva el orden original de secciones, GIFs y posts incrustados en artículos', () => {
    const original = originalTweet();
    const gif = 'https://video.twimg.com/tweet_video/example.mp4';
    const [post] = extractTweetsFromPayload(payloadWith([entry('tweet-123', {
      ...original,
      article: { article_results: { result: {
        rest_id: '999',
        title: 'Informe',
        media_entities: [{ media_id: '30', media_info: {
          __typename: 'AnimatedGif', variants: [{ url: gif, content_type: 'video/mp4' }],
        } }],
        content_state: {
          entityMap: [
            { key: '4', value: { data: { mediaItems: [{ mediaId: '30' }], caption: 'Evolución' } } },
            { key: '7', value: { data: { tweetId: '15', title: 'Publicación original' } } },
          ],
          blocks: [
            { type: 'header-two', text: 'Resultados' },
            { type: 'unstyled', text: 'Observa la animación.' },
            { type: 'atomic', text: ' ', entityRanges: [{ key: 4 }] },
            { type: 'atomic', text: ' ', entityRanges: [{ key: 7 }] },
          ],
        },
      } } },
    })]), COLLECTED_AT);
    expect(post?.article?.blocks).toEqual([
      { kind: 'heading', text: 'Resultados' },
      { kind: 'text', text: 'Observa la animación.' },
      { kind: 'media', media: expect.objectContaining({ type: 'gif', url: gif }), caption: 'Evolución' },
      { kind: 'embed', url: 'https://x.com/i/status/15', text: 'Publicación original' },
    ]);
  });

  it('normaliza un post original con autor, métricas, entidades y media', () => {
    const posts = extractTweetsFromPayload(payloadWith([entry('tweet-123', originalTweet())]), COLLECTED_AT);

    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post).toBeDefined();
    expect(post!.id).toBe('123');
    expect(post!.createdAt).toBe('2026-11-12T14:30:00.000Z');
    expect(post!.author).toMatchObject({
      handle: 'ana',
      name: 'Ana Pérez',
      verified: true,
    });
    expect(post!.text).toBe('Hola mundo #xense, gracias @bob');
    expect(post!.type).toBe('original');
    expect(post!.isReply).toBe(false);
    expect(post!.hashtags).toEqual(['xense']);
    expect(post!.mentions).toEqual(['bob']);
    expect(post!.urls).toEqual(['https://example.com/nota']);
    expect(post!.media).toHaveLength(1);
    expect(post!.media[0]).toMatchObject({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/foto.jpg',
      alt: 'Una foto',
    });
    expect(post!.metrics).toMatchObject({
      likes: 12,
      reposts: 3,
      replies: 1,
      quotes: 2,
      bookmarks: 1,
    });
    expect(post!.permalink).toBe('https://x.com/ana/status/123');
    expect(post!.collectedAt).toBe(COLLECTED_AT);
  });

  it('descarta entradas promocionadas', () => {
    const promoted = entry('promoted-tweet-999', originalTweet());
    const posts = extractTweetsFromPayload(
      payloadWith([promoted, entry('tweet-123', originalTweet())]),
      COLLECTED_AT,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.id).toBe('123');
  });

  it('deduplica posts repetidos por id', () => {
    const posts = extractTweetsFromPayload(
      payloadWith([entry('tweet-123', originalTweet()), entry('cursor-bottom', originalTweet())]),
      COLLECTED_AT,
    );

    expect(posts).toHaveLength(1);
  });

  it('normaliza un repost conservando el autor original y la fecha del repost', () => {
    const repost = {
      __typename: 'Tweet',
      rest_id: '999',
      core: {
        user_results: {
          result: {
            rest_id: 'u2',
            core: { screen_name: 'reposter', name: 'Reposter' },
          },
        },
      },
      legacy: {
        created_at: 'Fri Nov 13 09:00:00 +0000 2026',
        full_text: 'RT @ana: Hola mundo',
        retweeted_status_result: { result: originalTweet() },
      },
    };

    const posts = extractTweetsFromPayload(payloadWith([entry('tweet-999', repost)]), COLLECTED_AT);

    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post!.id).toBe('999');
    expect(post!.type).toBe('repost');
    expect(post!.isRepost).toBe(true);
    expect(post!.createdAt).toBe('2026-11-13T09:00:00.000Z');
    expect(post!.originalCreatedAt).toBe('2026-11-12T14:30:00.000Z');
    expect(post!.author.handle).toBe('ana');
    expect(post!.repostedBy?.handle).toBe('reposter');
  });

  it('normaliza una cita con el post citado', () => {
    const quote = {
      ...originalTweet(),
      rest_id: '555',
      legacy: {
        ...originalTweet().legacy,
        full_text: 'Mira esto',
        quoted_status_result: { result: originalTweet() },
      },
    };

    const posts = extractTweetsFromPayload(payloadWith([entry('tweet-555', quote)]), COLLECTED_AT);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.type).toBe('quote');
    expect(posts[0]!.isQuote).toBe(true);
    expect(posts[0]!.quoted).toMatchObject({
      id: '123',
      handle: 'ana',
      text: 'Hola mundo #xense, gracias @bob',
    });
  });

  it('normaliza un hilo largo desde note_tweet', () => {
    const longTweet = {
      ...originalTweet(),
      legacy: {
        ...originalTweet().legacy,
        full_text: 'Texto corto',
      },
      note_tweet: {
        note_tweet_results: {
          result: {
            text: 'Este es el texto completo del post largo.',
            entity_set: {
              hashtags: [{ text: 'largo' }],
              urls: [{ expanded_url: 'https://example.com/largo' }],
            },
          },
        },
      },
    };

    const posts = extractTweetsFromPayload(payloadWith([entry('tweet-123', longTweet)]), COLLECTED_AT);

    expect(posts[0]!.text).toBe('Este es el texto completo del post largo.');
    expect(posts[0]!.hashtags).toEqual(['xense', 'largo']);
    expect(posts[0]!.urls).toEqual(['https://example.com/nota', 'https://example.com/largo']);
  });

  it('ignora resultados no disponibles', () => {
    const posts = extractTweetsFromPayload(
      payloadWith([entry('tweet-1', { __typename: 'TweetTombstone' })]),
      COLLECTED_AT,
    );
    expect(posts).toHaveLength(0);
  });
});

describe('extractListsFromPayload', () => {
  it('extrae listas con id, nombre, miembros y propietario', () => {
    const payload = {
      data: {
        viewer: {
          lists: {
            items: [
              {
                __typename: 'List',
                id_str: '111',
                name: 'Tecnología',
                member_count: 42,
                user_results: {
                  result: {
                    core: { screen_name: 'owner' },
                  },
                },
              },
              {
                __typename: 'User',
                rest_id: 'u9',
                name: 'Ana',
              },
            ],
          },
        },
      },
    };

    const lists = extractListsFromPayload(payload, COLLECTED_AT);

    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      id: '111',
      name: 'Tecnología',
      memberCount: 42,
      ownerHandle: 'owner',
      url: 'https://x.com/i/lists/111',
      source: 'graphql',
      updatedAt: COLLECTED_AT,
    });
  });

  it('prefiere la entrada con más miembros cuando hay duplicados', () => {
    const payload = {
      items: [
        { __typename: 'List', id_str: '111', name: 'Lista', member_count: 5 },
        { __typename: 'List', id_str: '111', name: 'Lista', member_count: 90 },
      ],
    };

    const lists = extractListsFromPayload(payload, COLLECTED_AT);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.memberCount).toBe(90);
  });

  it('no produce listas con payloads sin listas', () => {
    expect(extractListsFromPayload({ data: { viewer: {} } }, COLLECTED_AT)).toEqual([]);
  });
});
