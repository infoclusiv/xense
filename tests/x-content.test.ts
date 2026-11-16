import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentContext, ContentToBackgroundMessage } from '../lib/types';

const listUrl = 'https://x.com/i/lists/42';
const searchUrl =
  'https://x.com/search?q=' +
  encodeURIComponent('list:42 since:2026-11-12_05:00:00_UTC until:2026-11-13_05:00:00_UTC') +
  '&src=typed_query&f=live';
const windowStart = '2026-11-12T05:00:00.000Z';
const windowEnd = '2026-11-13T05:00:00.000Z';

function collectionContext(
  manualScroll: boolean,
  overrides: Partial<ContentContext> = {},
): ContentContext {
  return {
    runId: 'run',
    listId: '42',
    listName: 'Lista 42',
    range: {
      start: windowStart,
      end: windowEnd,
      timezone: 'UTC',
      label: '',
      expression: '',
      partial: false,
      rolling: false,
    },
    mode: 'search',
    strategy: 'search',
    windowIndex: 0,
    windowStart,
    windowEnd,
    windowMode: 'search',
    expectedUrl: searchUrl,
    paused: false,
    includeReplies: true,
    includeReposts: true,
    includeQuotes: true,
    maxPosts: 100,
    minDelayMs: 1000,
    maxDelayMs: 1000,
    idleScrolls: 3,
    maxScrolls: 10,
    manualScroll,
    humanizeLevel: 'off',
    blankClicks: false,
    alreadyCaptured: 0,
    ...overrides,
  };
}

function listContext(overrides: Partial<ContentContext> = {}): ContentContext {
  return collectionContext(false, {
    mode: 'auto',
    strategy: 'list',
    windowMode: 'list',
    expectedUrl: listUrl,
    ...overrides,
  });
}

async function openPage(url: string, context: ContentContext | null) {
  vi.useFakeTimers();
  vi.resetModules();
  const messages: ContentToBackgroundMessage[] = [];
  const location = new URL(url);
  const click = vi.fn();
  let onPageMessage: ((event: MessageEvent) => void) | undefined;
  const page = {
    addEventListener: (_name: string, listener: (event: MessageEvent) => void) => {
      onPageMessage = listener;
    },
    scrollTo: vi.fn(),
    scrollY: 0,
    innerHeight: 700,
    setTimeout,
    setInterval,
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', {
    body: { innerText: '', scrollHeight: 2500 },
    documentElement: { scrollHeight: 2500 },
    hidden: false,
    visibilityState: 'visible',
    querySelectorAll: (selector: string) => {
      if (selector.startsWith('button')) return [{ textContent: 'Ver más', click }];
      return [];
    },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'xense',
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(async (message: ContentToBackgroundMessage) => {
        messages.push(message);
        return { ok: true, context };
      }),
    },
  });
  vi.stubGlobal('defineContentScript', (definition: { main: () => void }) => {
    definition.main();
    return definition;
  });
  await import('../entrypoints/x.content');
  return {
    page,
    click,
    messages,
    location,
    receive: (data: object) => onPageMessage?.({
      source: page,
      origin: location.origin,
      data: { source: 'xense-page', ...data },
    } as unknown as MessageEvent),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('observación de solicitudes en X', () => {
  it('pasa las escrituras al sitio una sola vez y observa el límite de la lectura del timeline', async () => {
    vi.resetModules();
    const postMessage = vi.fn();
    const clone = vi.fn();
    const write = Promise.resolve({ status: 200, ok: true, clone });
    const limitedRead = Promise.resolve({ status: 429, ok: false });
    const fetch = vi.fn().mockReturnValueOnce(write).mockReturnValueOnce(limitedRead);
    const page = { fetch, postMessage };
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', new URL(listUrl));
    vi.stubGlobal('XMLHttpRequest', class { open() {} });
    vi.stubGlobal('defineContentScript', (definition: { main: () => void }) => {
      definition.main();
      return definition;
    });
    await import('../entrypoints/x-main.content');

    const writeUrl = '/i/api/graphql/example/ListAddMember';
    expect(page.fetch(writeUrl, { method: 'POST' })).toBe(write);
    await write;
    expect(fetch).toHaveBeenCalledExactlyOnceWith(writeUrl, { method: 'POST' });
    expect(clone).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();

    expect(page.fetch('/i/api/graphql/example/ListLatestTweetsTimeline')).toBe(limitedRead);
    await limitedRead;
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { source: 'xense-page', kind: 'rate_limited', operation: 'ListLatestTweetsTimeline' },
      'https://x.com',
    );
  });
});

describe('navegación en X', () => {
  it('no desplaza la pestaña de listas sin una recolección', async () => {
    const { page, click } = await openPage('https://x.com/i/lists', null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(page.scrollTo).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('guarda los posts cargados durante el desplazamiento manual', async () => {
    const { page, click, messages, receive } = await openPage(searchUrl, collectionContext(true));
    const post = { id: '1234', createdAt: windowStart };
    receive({ kind: 'tweets', posts: [post] });
    await vi.advanceTimersByTimeAsync(1600);
    page.scrollY = 250;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(page.scrollTo).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(messages).toContainEqual({ type: 'POSTS_BATCH', windowIndex: 0, posts: [post] });
    expect(messages).toContainEqual(expect.objectContaining({ type: 'PROGRESS', scrolls: 1 }));
    expect(messages.some(({ type }) => type === 'WINDOW_DONE')).toBe(false);
  });

  it('desplaza en modo automático sin hacer clic y se detiene al salir de la búsqueda', async () => {
    const { page, click, messages, location, receive } = await openPage(
      searchUrl,
      collectionContext(false),
    );
    receive({ kind: 'tweets', posts: [{ id: '1234', createdAt: windowStart }] });
    await vi.advanceTimersByTimeAsync(1100);
    const scrollCount = page.scrollTo.mock.calls.length;
    expect(scrollCount).toBeGreaterThan(0);
    location.pathname = '/another-profile';
    await vi.advanceTimersByTimeAsync(5000);

    expect(page.scrollTo).toHaveBeenCalledTimes(scrollCount);
    expect(click).not.toHaveBeenCalled();
    expect(messages).toContainEqual(expect.objectContaining({ type: 'WINDOW_FAILED', reason: 'navigation_changed' }));
  });

  it('detiene la ventana sin desplazarse si X devuelve un límite al cargarla', async () => {
    const { page, messages, receive } = await openPage(searchUrl, collectionContext(false));
    receive({ kind: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(5000);

    expect(page.scrollTo).not.toHaveBeenCalled();
    expect(messages).toContainEqual(expect.objectContaining({ type: 'WINDOW_FAILED', reason: 'rate_limited' }));
  });

  it('recorre la lista y termina al confirmar la fecha de inicio', async () => {
    const { page, click, messages, receive } = await openPage(listUrl, listContext());
    receive({
      kind: 'tweets',
      posts: [
        { id: 'nuevo', createdAt: '2026-11-12T20:00:00.000Z' },
        { id: 'viejo', createdAt: '2026-11-10T12:00:00.000Z' },
      ],
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(page.scrollTo).toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'LIST_PASS_DONE',
        reason: 'date_boundary',
        reachedStart: true,
        coveredUntilAt: '2026-11-10T12:00:00.000Z',
      }),
    );
  });
});
