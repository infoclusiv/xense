import type {
  ContentContext,
  ContentToBackgroundMessage,
  DiagnosticEntry,
  ListInfo,
  MediaItem,
  NormalizedPost,
} from '../lib/types';

declare global {
  interface Window {
    __xenseHookInstalled?: boolean;
  }
}

const PAGE_SOURCE = 'xense-page';

let context: ContentContext | null = null;
let contextResolved = false;
let pendingTweets: NormalizedPost[] = [];
let scraping = false;
let paused = false;
let stopRequested = false;
let limitReached = false;
let extensionInvalidated = false;

let queuedPosts: NormalizedPost[] = [];
let flushing = false;
let flushScheduled = false;

const windowSeen = new Set<string>();
let currentWindowCaptured = 0;
let oldestSeenMs: number | null = null;
let hadPayload = false;
let pageHasResults = false;
let scrolls = 0;
let domFallbackUsed = false;
let lastProgressAt = 0;
let lastListsSignature = '';
let listDiscoveryStarted = false;
let listInfoSignature = '';

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  main() {
    window.addEventListener('message', onPageMessage, false);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    void boot();
    startUrlWatcher();
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(1, max - min));
}

function nowIso(): string {
  return new Date().toISOString();
}

async function boot(): Promise<void> {
  await waitForBody(8000);

  let ctx: ContentContext | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await sendBg<{ context: ContentContext | null }>({ type: 'CONTENT_READY' });
    ctx = response?.context ?? null;
    if (ctx) break;
    await sleep(700);
  }

  context = ctx;
  contextResolved = true;

  if (context) {
    paused = context.paused;
    if (pendingTweets.length > 0) {
      const pending = pendingTweets;
      pendingTweets = [];
      processIncomingPosts(pending, false);
    }
    void runScraper(context);
    return;
  }

  pendingTweets = [];
  void discoverListsIfNeeded();
  void reportListPageInfo();
}

function startUrlWatcher(): void {
  let lastUrl = location.href;
  window.setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (!context) {
      void discoverListsIfNeeded();
      void reportListPageInfo();
    }
  }, 1500);
}

async function waitForBody(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!document.body && Date.now() < deadline) {
    await sleep(100);
  }
}

function onPageMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE) return;

  if (data.kind === 'tweets' && Array.isArray(data.posts)) {
    const posts = data.posts as NormalizedPost[];
    if (!contextResolved) {
      pendingTweets.push(...posts);
      if (pendingTweets.length > 2000) pendingTweets = pendingTweets.slice(-2000);
    } else if (context) {
      processIncomingPosts(posts, false);
    }
    return;
  }

  if (data.kind === 'lists' && Array.isArray(data.lists)) {
    void upsertLists(data.lists as ListInfo[]);
  }
}

function onRuntimeMessage(
  message: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (message?.type === 'SCRAPER_PAUSE') {
    paused = true;
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'SCRAPER_RESUME') {
    paused = false;
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'SCRAPER_STOP') {
    stopRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'PING') {
    sendResponse({ ok: true, scraping, paused, hasContext: Boolean(context) });
    return false;
  }
  return false;
}

async function sendBg<T = any>(message: ContentToBackgroundMessage): Promise<T | null> {
  if (!runtimeAlive()) {
    extensionInvalidated = true;
    return null;
  }
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (String(error).includes('Extension context invalidated')) {
      extensionInvalidated = true;
      stopRequested = true;
    }
    return null;
  }
}

function runtimeAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function diagnostic(level: DiagnosticEntry['level'], message: string, operation?: string): void {
  void sendBg({
    type: 'PAGE_DIAGNOSTIC',
    entry: { at: nowIso(), level, message, operation },
  });
}

function processIncomingPosts(posts: NormalizedPost[], fromDom: boolean): void {
  if (!context) return;
  if (!fromDom) hadPayload = true;

  const startMs = Date.parse(context.windowStart);
  const endMs = Date.parse(context.windowEnd);

  for (const post of posts) {
    if (!post || typeof post.id !== 'string' || !post.id) continue;
    const createdMs = Date.parse(post.createdAt);
    if (!Number.isFinite(createdMs)) continue;

    if (oldestSeenMs === null || createdMs < oldestSeenMs) oldestSeenMs = createdMs;
    if (createdMs < startMs || createdMs >= endMs) continue;
    if (!context.includeReposts && post.isRepost) continue;
    if (!context.includeReplies && post.isReply) continue;
    if (!context.includeQuotes && post.isQuote && !post.isReply && !post.isRepost) continue;
    if (windowSeen.has(post.id)) continue;

    windowSeen.add(post.id);
    currentWindowCaptured += 1;
    queuedPosts.push(post);
  }

  if (posts.length > 0) pageHasResults = true;
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  window.setTimeout(() => {
    flushScheduled = false;
    void flushQueue();
  }, 450);
}

async function flushQueue(): Promise<void> {
  if (flushing || !context) return;
  flushing = true;
  try {
    while (queuedPosts.length > 0) {
      const batch = queuedPosts.splice(0, 100);
      const response = await sendBg<{ stop?: boolean; ok?: boolean }>({
        type: 'POSTS_BATCH',
        windowIndex: context.windowIndex,
        posts: batch,
      });
      if (!response) {
        queuedPosts.unshift(...batch);
        break;
      }
      if (response.stop) {
        limitReached = true;
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

function hasArticles(): boolean {
  return document.querySelectorAll('article[data-testid="tweet"]').length > 0;
}

function pageText(): string {
  return (document.body?.innerText ?? '').slice(0, 12000).toLowerCase();
}

function detectLoginWall(): boolean {
  if (location.pathname.includes('/i/flow/login') || location.pathname.includes('/login')) return true;
  if (hasArticles()) return false;
  const text = pageText();
  const hasLoginText =
    text.includes('sign in to x') ||
    text.includes('inicia sesion en x') ||
    text.includes('iniciar sesion en x') ||
    text.includes('inicia sesión en x') ||
    text.includes('iniciar sesión en x');
  return hasLoginText && !hadPayload;
}

function detectRateLimit(): boolean {
  const text = pageText();
  return (
    text.includes('rate limit') ||
    text.includes('you are over the daily limit') ||
    text.includes('limite de velocidad') ||
    text.includes('límite de velocidad') ||
    text.includes('demasiadas solicitudes')
  );
}

function detectNoResults(): boolean {
  const text = pageText();
  return (
    text.includes('no results for') ||
    text.includes('no results') ||
    text.includes('no hay resultados') ||
    text.includes('no se encontraron resultados') ||
    text.includes('this search returned no results')
  );
}

function detectPageError(): boolean {
  const text = pageText();
  return (
    text.includes('something went wrong') ||
    text.includes('try reloading') ||
    text.includes('algo salio mal') ||
    text.includes('algo salió mal') ||
    text.includes('intenta recargar')
  );
}

function clickRetry(): boolean {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
  const button = candidates.find((element) =>
    /retry|reintentar|try again|inténtalo de nuevo|intentalo de nuevo/i.test(
      element.textContent ?? '',
    ),
  );
  if (button) {
    button.click();
    return true;
  }
  return false;
}

function clickShowMore(): boolean {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
  const button = candidates.find((element) =>
    /show more|mostrar más|mostrar mas|ver más|ver mas|cargar más|cargar mas/i.test(
      element.textContent ?? '',
    ),
  );
  if (button) {
    button.click();
    return true;
  }
  return false;
}

function scrollToBottom(): void {
  const height = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  window.scrollTo(0, height);
  document.documentElement.scrollTop = height;
  if (document.body) document.body.scrollTop = height;
}

function sendProgress(phase: 'waiting_page' | 'scrolling', message: string, force = false): void {
  if (!context) return;
  const now = Date.now();
  if (!force && now - lastProgressAt < 1500) return;
  lastProgressAt = now;
  void sendBg({
    type: 'PROGRESS',
    windowIndex: context.windowIndex,
    scrolls,
    windowCaptured: currentWindowCaptured,
    oldestSeenAt: oldestSeenMs !== null ? new Date(oldestSeenMs).toISOString() : null,
    pageHasResults: hadPayload || hasArticles(),
    hidden: document.visibilityState === 'hidden',
    phase,
    message,
  });
}

async function waitForInitialState(ctx: ContentContext): Promise<string | null> {
  const deadline = Date.now() + 30000;
  let errorSeen = 0;
  while (Date.now() < deadline) {
    await flushQueue();
    sendProgress('waiting_page', 'Esperando los resultados de X…');

    if (stopRequested || extensionInvalidated) return 'cancelled';
    if (detectRateLimit()) return 'rate_limited';
    if (detectLoginWall()) return 'login_required';

    if (hadPayload || hasArticles()) return null;

    if (detectNoResults()) return 'no_results';
    if (detectPageError()) {
      errorSeen += 1;
      if (errorSeen === 1 && clickRetry()) {
        await sleep(2500);
        continue;
      }
      return 'page_error';
    }

    await sleep(800);
  }
  return 'no_results';
}

async function runScraper(ctx: ContentContext): Promise<void> {
  if (scraping) return;
  scraping = true;
  stopRequested = false;
  limitReached = false;
  windowSeen.clear();
  queuedPosts = [];
  currentWindowCaptured = 0;
  oldestSeenMs = null;
  hadPayload = false;
  pageHasResults = false;
  scrolls = 0;
  domFallbackUsed = false;
  lastProgressAt = 0;

  const initialReason = await waitForInitialState(ctx);
  if (initialReason) {
    await finish(initialReason, initialReasonMessage(initialReason));
    return;
  }

  const startMs = Date.parse(ctx.windowStart);
  let idleScrolls = 0;
  let lastCaptured = windowSeen.size;
  let lastHeight = 0;
  let showMoreClicks = 0;
  const loopStartedAt = Date.now();
  let lastDomScan = 0;
  let pageErrorCount = 0;

  try {
    while (true) {
      await flushQueue();

      if (extensionInvalidated) {
        await finish('cancelled', 'La extensión se recargó y la recolección se detuvo.');
        return;
      }
      if (stopRequested) {
        await finish('cancelled', 'Recolección detenida por el usuario.');
        return;
      }
      if (limitReached) {
        await finish('max_posts', 'Se alcanzó el máximo de posts configurado.');
        return;
      }

      if (paused) {
        sendProgress('scrolling', 'Recolección pausada.', true);
        await sleep(900);
        continue;
      }

      if (currentWindowCaptured + ctx.alreadyCaptured >= ctx.maxPosts) {
        await finish('max_posts', 'Se alcanzó el máximo de posts configurado.');
        return;
      }

      if (oldestSeenMs !== null && oldestSeenMs < startMs && scrolls >= 3) {
        await finish('date_boundary', 'Se cruzó la fecha de inicio del rango.');
        return;
      }

      if (detectRateLimit()) {
        await finish('rate_limited', 'X limitó temporalmente la carga de resultados.');
        return;
      }

      if (detectLoginWall()) {
        await finish('login_required', 'X solicita iniciar sesión.');
        return;
      }

      if (detectPageError()) {
        pageErrorCount += 1;
        if (pageErrorCount === 1 && clickRetry()) {
          await sleep(2500);
          continue;
        }
        if (pageErrorCount >= 2) {
          await finish('page_error', 'X devolvió un error al cargar más resultados.');
          return;
        }
      } else {
        pageErrorCount = 0;
      }

      if (scrolls >= ctx.maxScrolls) {
        await finish('max_scrolls', 'Se alcanzó el límite de desplazamientos.');
        return;
      }

      if (idleScrolls >= ctx.idleScrolls) {
        await finish('exhausted', 'No aparecieron más posts.');
        return;
      }

      if (!hadPayload && Date.now() - loopStartedAt > 5000 && Date.now() - lastDomScan > 3500) {
        const domPosts = scrapeDomPosts();
        lastDomScan = Date.now();
        if (domPosts.length > 0) {
          if (!domFallbackUsed) {
            domFallbackUsed = true;
            diagnostic('warn', 'No se detectaron respuestas GraphQL; usando extracción desde el DOM.');
          }
          processIncomingPosts(domPosts, true);
        }
      }

      if (clickShowMore() && showMoreClicks < 30) {
        showMoreClicks += 1;
        await sleep(1200);
      }

      const heightBefore = document.documentElement.scrollHeight;
      scrollToBottom();
      scrolls += 1;
      const delay = randomBetween(ctx.minDelayMs, ctx.maxDelayMs);
      await sleep(delay);
      await flushQueue();

      const heightAfter = document.documentElement.scrollHeight;
      const capturedNow = windowSeen.size;
      if (capturedNow !== lastCaptured || heightAfter !== lastHeight || heightAfter !== heightBefore) {
        idleScrolls = 0;
      } else {
        idleScrolls += 1;
      }
      lastCaptured = capturedNow;
      lastHeight = heightAfter;

      sendProgress(
        'scrolling',
        `Ventana ${ctx.windowIndex + 1}: ${currentWindowCaptured} posts válidos · ${scrolls} desplazamientos.`,
      );
    }
  } catch (error) {
    console.error('[Xense] Error durante la recolección:', error);
    await finish('page_error', `Error inesperado: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function initialReasonMessage(reason: string): string {
  switch (reason) {
    case 'login_required':
      return 'X solicita iniciar sesión. Abre x.com e inicia sesión antes de recolectar.';
    case 'rate_limited':
      return 'X limitó temporalmente la carga. Espera unos minutos y vuelve a intentarlo.';
    case 'no_results':
      return 'No se encontraron posts para esta ventana.';
    case 'page_error':
      return 'X devolvió un error al cargar los resultados.';
    default:
      return 'La recolección se detuvo.';
  }
}

async function finish(reason: string, message: string): Promise<void> {
  if (!context) return;
  await flushQueue();
  sendProgress('scrolling', message, true);
  const failureReasons = new Set(['login_required', 'rate_limited', 'page_error']);
  if (failureReasons.has(reason)) {
    await sendBg({
      type: 'WINDOW_FAILED',
      windowIndex: context.windowIndex,
      reason,
      message,
    });
  } else {
    await sendBg({
      type: 'WINDOW_DONE',
      windowIndex: context.windowIndex,
      reason,
      scrolls,
      windowCaptured: currentWindowCaptured,
      oldestSeenAt: oldestSeenMs !== null ? new Date(oldestSeenMs).toISOString() : null,
    });
  }
  scraping = false;
}

function parseCompactNumber(value: string): number {
  const text = value.replace(/\s/g, '').replace(/,/g, '.');
  const match = /(\d+(?:\.\d+)?)\s*([kmb])?/i.exec(text);
  if (!match) return 0;
  let number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') number *= 1_000;
  else if (suffix === 'm') number *= 1_000_000;
  else if (suffix === 'b') number *= 1_000_000_000;
  return Math.round(number);
}

function scrapeDomPosts(): NormalizedPost[] {
  const articles = Array.from(document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  const collectedAt = nowIso();
  const posts = new Map<string, NormalizedPost>();

  for (const article of articles) {
    const time = article.querySelector('time[datetime]');
    const createdAtRaw = time?.getAttribute('datetime');
    if (!createdAtRaw) continue;
    const createdMs = Date.parse(createdAtRaw);
    if (!Number.isFinite(createdMs)) continue;

    const links = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'));
    let id: string | undefined;
    const timeMatch = /\/status\/(\d+)/.exec(
      time?.closest('a[href*="/status/"]')?.getAttribute('href') ?? '',
    );
    if (timeMatch?.[1]) id = timeMatch[1];
    if (!id) {
      for (const link of links) {
        const match = /\/status\/(\d+)/.exec(link.getAttribute('href') ?? '');
        if (match?.[1]) {
          id = match[1];
          break;
        }
      }
    }
    if (!id) continue;

    const userBlock = article.querySelector<HTMLElement>('[data-testid="User-Name"]');
    const userText = (userBlock?.innerText ?? '').trim();
    const handleMatch = /@([A-Za-z0-9_]+)/.exec(userText);
    const handle = handleMatch?.[1] ?? 'desconocido';
    const name =
      userText
        .split(/\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('@')) ?? handle;

    const text = (article.querySelector<HTMLElement>('[data-testid="tweetText"]')?.innerText ?? '').trim();
    const articleText = (article.innerText ?? '').toLowerCase();
    const socialText = (
      article.querySelector<HTMLElement>('[data-testid="socialContext"]')?.innerText ?? ''
    ).toLowerCase();
    const isRepost = /repost|reposte|retweet|retwitte|reposteó|reposteo/.test(socialText);
    const isReply = /replying to|respondiendo a/.test(articleText);
    const isQuote = Boolean(article.querySelector('[data-testid="quoteTweet"]'));

    const metric = (testId: string): number => {
      const element = article.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!element) return 0;
      return parseCompactNumber(element.getAttribute('aria-label') ?? element.innerText ?? '');
    };

    const media: MediaItem[] = [];
    const mediaSeen = new Set<string>();
    for (const image of Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]'))) {
      const url = image.getAttribute('src');
      if (!url || mediaSeen.has(url)) continue;
      mediaSeen.add(url);
      media.push({ type: 'photo', url, alt: image.getAttribute('alt') ?? undefined });
    }

    posts.set(id, {
      id,
      createdAt: new Date(createdMs).toISOString(),
      author: { handle, name },
      text,
      type: isRepost ? 'repost' : isReply ? 'reply' : isQuote ? 'quote' : 'original',
      isReply,
      isRepost,
      isQuote,
      repostedBy: null,
      urls: [],
      hashtags: [],
      mentions: [],
      media,
      metrics: {
        likes: metric('like'),
        reposts: metric('retweet'),
        replies: metric('reply'),
        quotes: 0,
        views: 0,
        bookmarks: metric('bookmark'),
      },
      permalink: `https://x.com/${handle}/status/${id}`,
      collectedAt,
    });
  }

  return [...posts.values()];
}

function isListsIndexPage(): boolean {
  const path = location.pathname.replace(/\/+$/, '');
  return path === '/i/lists' || /^\/[^/]+\/lists$/.test(path);
}

function isListDetailPage(): boolean {
  return /^\/i\/lists\/\d+$/.test(location.pathname.replace(/\/+$/, ''));
}

function scrapeListsFromDom(): ListInfo[] {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/i/lists/"]'));
  const lists = new Map<string, ListInfo>();
  const updatedAt = nowIso();

  for (const anchor of anchors) {
    const match = /\/i\/lists\/(\d+)/.exec(anchor.getAttribute('href') ?? '');
    const id = match?.[1];
    if (!id) continue;
    const text = (anchor.innerText || anchor.getAttribute('aria-label') || '').trim();
    const lines = text
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const name = lines.find(
      (line) =>
        !/^@/.test(line) &&
        !/^\d[\d.,]*\s*(miembros|members|seguidores|followers|suscriptores|subscribers)/i.test(line) &&
        !/^(lists|listas|miembros|members)$/i.test(line),
    );
    if (!name) continue;

    const memberMatch = /([\d.,]+)\s*(miembros|members)/i.exec(text);
    const memberCount = memberMatch?.[1]
      ? Number(memberMatch[1].replace(/[.,]/g, ''))
      : undefined;

    lists.set(id, {
      id,
      name,
      memberCount: Number.isFinite(memberCount) ? memberCount : undefined,
      url: `https://x.com/i/lists/${id}`,
      source: 'dom',
      updatedAt,
    });
  }

  return [...lists.values()];
}

async function upsertLists(lists: ListInfo[]): Promise<void> {
  const valid = lists.filter((list) => /^\d+$/.test(list.id) && list.name.trim());
  if (valid.length === 0) return;
  await sendBg({ type: 'UPSERT_LISTS', lists: valid });
}

async function discoverListsIfNeeded(): Promise<void> {
  if (context || listDiscoveryStarted || !isListsIndexPage()) return;
  listDiscoveryStarted = true;

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const lists = scrapeListsFromDom();
    if (lists.length > 0) {
      const signature = lists.map((list) => `${list.id}:${list.name}`).join('|');
      if (signature !== lastListsSignature) {
        lastListsSignature = signature;
        await upsertLists(lists);
      }
    }
    if (iteration < 11) {
      scrollToBottom();
      await sleep(1600);
    }
  }
}

async function reportListPageInfo(): Promise<void> {
  if (context || !isListDetailPage()) return;
  const id = location.pathname.match(/\/i\/lists\/(\d+)/)?.[1];
  if (!id) return;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const headers = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="primaryColumn"] h2[role="heading"], main h2[role="heading"]',
      ),
    );
    const names = headers
      .map((header) => (header.innerText ?? '').trim())
      .filter(
        (name) =>
          name &&
          !/^(lists?|listas?|miembros|members|siguiendo|following|seguidores|followers)$/i.test(name),
      );
    let name = names.sort((a, b) => b.length - a.length)[0];
    if (!name) {
      const title = document.title.replace(/\s*\/\s*X\s*$/i, '').trim();
      if (title && title.toLowerCase() !== 'x' && title.toLowerCase() !== 'inicio') name = title;
    }
    if (name) {
      const headerText = headers.map((header) => header.innerText).join(' ');
      const memberMatch = /([\d.,]+)\s*(miembros|members)/i.exec(headerText);
      const signature = `${id}:${name}`;
      if (signature !== listInfoSignature) {
        listInfoSignature = signature;
        await sendBg({
          type: 'LIST_INFO',
          list: {
            id,
            name,
            memberCount: memberMatch?.[1]
              ? Number(memberMatch[1].replace(/[.,]/g, ''))
              : undefined,
            url: `https://x.com/i/lists/${id}`,
            source: 'dom',
            updatedAt: nowIso(),
          },
        });
      }
      return;
    }
    await sleep(900);
  }
}
