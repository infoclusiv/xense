import type {
  ContentContext,
  ContentToBackgroundMessage,
  DiagnosticEntry,
  ListInfo,
  MediaItem,
  NormalizedPost,
  PostArticle,
} from '../lib/types';
import {
  humanizeProfile,
  humanizedDelay,
  nextBlankClickDelay,
  planBoundary,
  planPointerPath,
  planReadingPause,
  planScrollStep,
  randomBetween,
  type HumanizeProfile,
  type Point,
} from '../lib/x/humanize';
import { listPassReachedStart } from '../lib/x/strategy';
import { mergePostContext } from '../lib/x/normalize';
import { articleText, readArticleBlocks } from '../lib/article';
import { articleIdFromPath, matchesWindowUrl, postIdFromPath, postIdFromUrl } from '../lib/x/urls';

const PAGE_SOURCE = 'xense-page';
const FRONTIER_SIZE = 24;
const USER_GRACE_MS = 8_000;

let context: ContentContext | null = null;
let contextResolved = false;
let pendingTweets: NormalizedPost[] = [];
let scraping = false;
let paused = false;
let stopRequested = false;
let limitReached = false;
let extensionInvalidated = false;

let queuedPosts: NormalizedPost[] = [];
let flushing: Promise<void> | null = null;
let flushScheduled = false;

const windowSeen = new Map<string, NormalizedPost>();
const detailPosts = new Map<string, NormalizedPost>();
let detailLimited = false;
let detailPage = false;
let currentWindowCaptured = 0;
let oldestSeenMs: number | null = null;
let hadPayload = false;
let rateLimited = false;
let scrolls = 0;
let domFallbackUsed = false;
let lastProgressAt = 0;
let lastListsSignature = '';
let listInfoSignature = '';

/** Fechas de los últimos posts únicos vistos, en orden de aparición. */
let frontierDates: number[] = [];
const frontierIds = new Set<string>();
let boundaryMarginMs = 0;
let boundaryRequiredStreak = 2;
let boundaryStreak = 0;
let humanProfile: HumanizeProfile = humanizeProfile('off');
let blankClickBudget = 0;
let blankClicksDone = 0;
let nextBlankClickAt = Number.POSITIVE_INFINITY;
let lastPointerAt = 0;
let lastPointer: Point | null = null;
let lastUserInputAt = 0;

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  main() {
    detailPage = location.hash === '#xense-context';
    window.addEventListener('message', onPageMessage, false);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    watchTrustedUserInput();
    void boot();
    startUrlWatcher();
  },
});

function watchTrustedUserInput(): void {
  const mark = (event: Event) => {
    if (event.isTrusted) lastUserInputAt = Date.now();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener?.(type, mark, { passive: true, capture: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    void runScraper(context);
    return;
  }

  pendingTweets = [];
  void discoverVisibleLists();
  void reportListPageInfo();
}

function startUrlWatcher(): void {
  let lastUrl = location.href;
  window.setInterval(() => {
    if (contextResolved && !context) void discoverVisibleLists();
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (contextResolved && !context) void reportListPageInfo();
  }, 1500);
}

async function waitForBody(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!document.body && Date.now() < deadline) {
    await sleep(100);
  }
}

function onPageMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE) return;
  const onCollectionPage = context && scraping && matchesWindowUrl(location.href, context.expectedUrl);

  if (detailPage && data.kind === 'detail_limited') detailLimited = true;
  if (detailPage && data.kind === 'detail' && Array.isArray(data.posts)) {
    for (const post of (data.posts as NormalizedPost[]).slice(0, 300)) {
      if (/^\d{1,30}$/.test(post?.id) && typeof post.text === 'string' && post.author
        && Array.isArray(post.media) && Array.isArray(post.urls)) {
        detailPosts.set(post.id, mergePostContext(detailPosts.get(post.id), post));
      }
    }
    return;
  }

  if (data.kind === 'rate_limited' && (!contextResolved || onCollectionPage)) {
    rateLimited = true;
    return;
  }

  if (data.kind === 'tweets' && Array.isArray(data.posts)) {
    const posts = data.posts as NormalizedPost[];
    if (!contextResolved) {
      pendingTweets.push(...posts);
      if (pendingTweets.length > 2000) pendingTweets = pendingTweets.slice(-2000);
    } else if (onCollectionPage && !stopRequested) {
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
  if (message?.type === 'READ_X_CONTEXT' && detailPage) {
    const id = postIdFromPath(location.pathname);
    const articleId = articleIdFromPath(location.pathname);
    if (articleId && articleId === message.articleId) {
      sendResponse({ limited: detailLimited, article: readDomArticle(articleId) });
    } else if (message.postId && (id === message.postId || detailPosts.has(message.postId))) {
      const domPost = scrapeDomPosts().find(post => post.id === message.postId);
      const captured = detailPosts.get(message.postId);
      const post = domPost ? mergePostContext(captured, domPost) : captured;
      const related: NormalizedPost[] = [];
      const seen = new Set([message.postId]);
      const ids = [post?.replyToPostId, post?.conversationId, post?.quotedPostId, post?.originalPostId];
      for (const relatedId of ids) {
        if (!relatedId || seen.has(relatedId) || related.length >= 5) continue;
        seen.add(relatedId);
        const adjacent = detailPosts.get(relatedId);
        if (!adjacent) continue;
        related.push(adjacent);
        ids.push(adjacent.replyToPostId, adjacent.quotedPostId);
      }
      sendResponse({
        limited: detailLimited,
        captured: Boolean(captured),
        post,
        related,
      });
    }
    return false;
  }
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

function observePostDates(posts: NormalizedPost[]): void {
  for (const post of posts) {
    if (!post || typeof post.id !== 'string' || !post.id) continue;
    const createdMs = Date.parse(post.createdAt);
    if (!Number.isFinite(createdMs)) continue;

    if (oldestSeenMs === null || createdMs < oldestSeenMs) oldestSeenMs = createdMs;
    if (frontierIds.has(post.id)) continue;
    frontierIds.add(post.id);
    frontierDates.push(createdMs);
    if (frontierDates.length > FRONTIER_SIZE) frontierDates.shift();
  }
}

/** Fecha más antigua confirmada por la cola reciente; null si aún no hay datos. */
function currentFrontierMs(): number | null {
  if (frontierDates.length === 0) return null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const value of frontierDates) oldest = Math.min(oldest, value);
  return Number.isFinite(oldest) ? oldest : null;
}

function frontierIso(): string | null {
  const frontier = currentFrontierMs();
  return frontier !== null ? new Date(frontier).toISOString() : null;
}

function processIncomingPosts(posts: NormalizedPost[], fromDom: boolean): void {
  if (!context) return;
  if (!fromDom) hadPayload = true;

  observePostDates(posts);

  const startMs = Date.parse(context.windowStart);
  const endMs = Date.parse(context.windowEnd);

  for (const post of posts) {
    if (!post || typeof post.id !== 'string' || !post.id) continue;
    const createdMs = Date.parse(post.createdAt);
    if (!Number.isFinite(createdMs)) continue;

    if (createdMs < startMs || createdMs >= endMs) continue;
    if (!context.includeReposts && post.isRepost) continue;
    if (!context.includeReplies && post.isReply) continue;
    if (!context.includeQuotes && post.isQuote && !post.isReply && !post.isRepost) continue;
    const previous = windowSeen.get(post.id);
    const merged = mergePostContext(previous, post);
    if (previous && JSON.stringify(previous) === JSON.stringify(merged)) continue;
    windowSeen.set(post.id, merged);
    if (!previous) currentWindowCaptured += 1;
    queuedPosts.push(merged);
  }

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

function flushQueue(): Promise<void> {
  if (flushing) return flushing;
  if (!context || queuedPosts.length === 0) return Promise.resolve();
  flushing = sendQueuedPosts(context.windowIndex).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function sendQueuedPosts(windowIndex: number): Promise<void> {
  while (queuedPosts.length > 0) {
    const batch = queuedPosts.splice(0, 100);
    const response = await sendBg<{ stop?: boolean; ok?: boolean }>({
      type: 'POSTS_BATCH',
      windowIndex,
      posts: batch,
    });
    if (!response) {
      queuedPosts.unshift(...batch);
      return;
    }
    if (response.stop) {
      limitReached = true;
      return;
    }
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

function pageNoticeText(): string {
  if (!hasArticles()) return pageText();
  const notices = document.querySelectorAll('[role="alert"], [data-testid="toast"], [data-testid="emptyState"]');
  return Array.from(notices, (notice) => notice.textContent ?? '').join(' ').toLowerCase();
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

function detectPageError(text: string): boolean {
  return (
    text.includes('something went wrong') ||
    text.includes('try reloading') ||
    text.includes('algo salio mal') ||
    text.includes('algo salió mal') ||
    text.includes('intenta recargar')
  );
}

function detectCollectionFailure(ctx: ContentContext): string | null {
  if (detectLoginWall()) return 'login_required';
  if (!matchesWindowUrl(location.href, ctx.expectedUrl)) return 'navigation_changed';
  const notice = pageNoticeText();
  if (rateLimited || /rate limit|over the daily limit|l[ií]mite de velocidad|demasiadas solicitudes/.test(notice)) {
    return 'rate_limited';
  }
  if (detectPageError(notice)) return 'page_error';
  return null;
}

async function sendProgress(phase: 'waiting_page' | 'scrolling', message: string): Promise<void> {
  if (!context) return;
  const now = Date.now();
  if (now - lastProgressAt < 1500) return;
  lastProgressAt = now;
  const frontier = frontierIso();
  const seen = frontier ?? (oldestSeenMs !== null ? new Date(oldestSeenMs).toISOString() : null);
  await sendBg({
    type: 'PROGRESS',
    windowIndex: context.windowIndex,
    scrolls,
    windowCaptured: currentWindowCaptured,
    oldestSeenAt: seen,
    coveredUntilAt: context.strategy === 'list' ? frontier : undefined,
    pageHasResults: hadPayload || hasArticles(),
    hidden: document.visibilityState === 'hidden',
    phase,
    message,
  });
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

async function waitForInitialState(ctx: ContentContext): Promise<string | null> {
  let deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await flushQueue();
    await sendProgress('waiting_page', 'Esperando los resultados de X…');

    if (stopRequested || extensionInvalidated) return 'cancelled';
    const failure = detectCollectionFailure(ctx);
    if (failure) return failure;

    if (hadPayload || hasArticles()) return null;

    if (detectNoResults()) return 'no_results';

    if (document.visibilityState === 'hidden') {
      // No gastar el plazo mientras la pestaña está en segundo plano.
      deadline += 900;
    }
    await sleep(800);
  }
  return 'no_results';
}

async function runScraper(ctx: ContentContext): Promise<void> {
  if (scraping) return;
  scraping = true;
  windowSeen.clear();
  queuedPosts = [];
  currentWindowCaptured = 0;
  oldestSeenMs = null;
  hadPayload = false;
  scrolls = 0;
  domFallbackUsed = false;
  lastProgressAt = 0;
  frontierDates = [];
  frontierIds.clear();
  boundaryStreak = 0;

  humanProfile = humanizeProfile(ctx.humanizeLevel);
  const boundary = planBoundary(humanProfile);
  boundaryMarginMs = boundary.marginMs;
  boundaryRequiredStreak = boundary.requiredStreak;
  blankClickBudget =
    ctx.blankClicks && !ctx.manualScroll ? humanProfile.blankClickBudget : 0;
  blankClicksDone = 0;
  nextBlankClickAt = Date.now() + nextBlankClickDelay(humanProfile);
  lastPointerAt = 0;
  lastPointer = null;
  lastUserInputAt = 0;

  if (pendingTweets.length > 0 && matchesWindowUrl(location.href, ctx.expectedUrl)) {
    processIncomingPosts(pendingTweets, false);
  }
  pendingTweets = [];

  const initialReason = await waitForInitialState(ctx);
  if (initialReason) {
    await finish(initialReason, initialReasonMessage(initialReason));
    return;
  }

  const listPass = ctx.strategy === 'list';
  const startMs = Date.parse(ctx.windowStart);
  const targetMs = listPass ? Date.parse(ctx.range.start) : startMs;
  let idleScrolls = 0;
  let lastCaptured = windowSeen.size;
  let lastHeight = document.documentElement.scrollHeight;
  let lastScrollTop = window.scrollY;
  let lastDomScan = 0;

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
      const pageFailure = detectCollectionFailure(ctx);
      if (pageFailure) {
        await finish(pageFailure, initialReasonMessage(pageFailure));
        return;
      }
      if (limitReached) {
        await finish('max_posts', 'Se alcanzó el máximo de posts configurado.');
        return;
      }

      if (paused || document.visibilityState === 'hidden') {
        lastScrollTop = window.scrollY;
        idleScrolls = 0;
        await sendProgress(
          'scrolling',
          paused
            ? 'Recolección pausada.'
            : 'La pestaña está en segundo plano; esperando a que vuelva a ser visible.',
        );
        await sleep(900);
        continue;
      }

      // No competir con el usuario si acaba de interactuar con la página.
      if (!ctx.manualScroll && Date.now() - lastUserInputAt < USER_GRACE_MS) {
        await sendProgress('scrolling', 'Detecté actividad tuya en la pestaña; espero un momento.');
        await sleep(700);
        continue;
      }

      if (currentWindowCaptured + ctx.alreadyCaptured >= ctx.maxPosts) {
        await finish('max_posts', 'Se alcanzó el máximo de posts configurado.');
        return;
      }

      const frontier = currentFrontierMs();
      if (listPass) {
        if (
          frontier !== null &&
          scrolls >= 2 &&
          listPassReachedStart(frontier, targetMs, boundaryMarginMs)
        ) {
          boundaryStreak += 1;
          if (boundaryStreak >= boundaryRequiredStreak) {
            await finish(
              'date_boundary',
              `Se alcanzó la fecha de inicio del rango (${shortDate(new Date(frontier).toISOString())}).`,
            );
            return;
          }
        } else {
          boundaryStreak = 0;
        }
      } else if (frontier !== null && frontier <= targetMs && scrolls >= 3) {
        boundaryStreak += 1;
        if (boundaryStreak >= 2) {
          await finish('date_boundary', 'Se cruzó la fecha de inicio de la ventana.');
          return;
        }
      } else {
        boundaryStreak = 0;
      }

      if (scrolls >= ctx.maxScrolls) {
        await finish('max_scrolls', 'Se alcanzó el límite de desplazamientos.');
        return;
      }

      if (idleScrolls >= ctx.idleScrolls) {
        await finish('exhausted', 'No aparecieron más posts.');
        return;
      }

      if (Date.now() - lastDomScan > 3500) {
        const domPosts = scrapeDomPosts();
        lastDomScan = Date.now();
        const validDomPosts = hadPayload ? domPosts.filter(post => windowSeen.has(post.id)) : domPosts;
        if (validDomPosts.length > 0) {
          if (!hadPayload && !domFallbackUsed) {
            domFallbackUsed = true;
            diagnostic('warn', 'No se detectaron respuestas GraphQL; usando extracción desde el DOM.');
          }
          processIncomingPosts(validDomPosts, true);
        }
      }

      const delay = ctx.manualScroll
        ? 1500
        : humanizedDelay(ctx.minDelayMs, ctx.maxDelayMs, humanProfile);
      if (!ctx.manualScroll) {
        performAutomaticScroll();
        scrolls += 1;
      }
      await interruptibleSleep(delay);
      await flushQueue();

      const heightAfter = document.documentElement.scrollHeight;
      const capturedNow = windowSeen.size;
      const scrollTop = window.scrollY;
      const atBottom = scrollTop + window.innerHeight >= heightAfter - 160;
      const waitingForScroll =
        ctx.manualScroll &&
        (document.hidden || scrollTop + window.innerHeight < heightAfter - 32);
      const moved = ctx.manualScroll && scrollTop !== lastScrollTop;
      if (moved && scrollTop > lastScrollTop) scrolls += 1;
      if (
        paused ||
        waitingForScroll ||
        moved ||
        capturedNow !== lastCaptured ||
        heightAfter !== lastHeight
      ) {
        idleScrolls = 0;
      } else if (atBottom) {
        idleScrolls += 1;
      } else {
        // Seguir bajando no es «no hay más posts»: aún queda timeline por recorrer.
        idleScrolls = Math.max(0, idleScrolls - 1);
      }
      lastCaptured = capturedNow;
      lastHeight = heightAfter;
      lastScrollTop = scrollTop;

      await maybeHumanBehavior();
      await sendProgress('scrolling', progressMessage(listPass, ctx));
    }
  } catch (error) {
    console.error('[Xense] Error durante la recolección:', error);
    await finish('page_error', `Error inesperado: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function progressMessage(listPass: boolean, ctx: ContentContext): string {
  if (listPass) {
    return `Recorriendo la lista: ${currentWindowCaptured} posts · ${scrolls} pasos · visto hasta ${shortDate(frontierIso())}.`;
  }
  return ctx.manualScroll
    ? `Ventana ${ctx.windowIndex + 1}: ${currentWindowCaptured} posts. Desplázate en X para cargar más.`
    : `Ventana ${ctx.windowIndex + 1}: ${currentWindowCaptured} posts válidos · ${scrolls} desplazamientos.`;
}

function performAutomaticScroll(): void {
  const height = document.documentElement.scrollHeight;
  if (!humanProfile.enabled) {
    window.scrollTo(0, height);
    return;
  }
  const viewport = window.innerHeight || 700;
  const maxTop = Math.max(0, height - viewport);
  const remaining = maxTop - window.scrollY;
  if (remaining <= 2) {
    window.scrollTo(0, maxTop);
    return;
  }
  const step = planScrollStep(viewport, remaining, humanProfile);
  window.scrollTo(0, Math.min(maxTop, window.scrollY + step));
}

/** Espera que respeta pausa, pestaña oculta y cancelación. */
async function interruptibleSleep(ms: number): Promise<void> {
  let deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) {
    if (stopRequested || extensionInvalidated) return;
    if (paused || document.visibilityState === 'hidden') {
      // El tiempo en pausa no consume la espera configurada.
      deadline += Math.min(500, Math.max(0, deadline - Date.now()));
      await sleep(250);
      continue;
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

async function maybeHumanBehavior(): Promise<void> {
  if (!humanProfile.enabled || !context || context.manualScroll) return;
  if (paused || stopRequested || document.visibilityState === 'hidden') return;

  const pause = planReadingPause(humanProfile);
  if (pause > 0) await interruptibleSleep(pause);
  if (paused || stopRequested) return;

  const now = Date.now();
  if (now - lastPointerAt >= 10_000 && Math.random() < humanProfile.pointerMoveChance) {
    await movePointerRandomly();
    lastPointerAt = Date.now();
  }

  if (blankClicksDone < blankClickBudget && Date.now() >= nextBlankClickAt) {
    if (tryBlankClick()) blankClicksDone += 1;
    nextBlankClickAt = Date.now() + nextBlankClickDelay(humanProfile);
  }
}

const UNSAFE_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  'video',
  'audio',
  'article',
  'header',
  'nav',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[contenteditable="true"]',
  '[data-testid="tweet"]',
  '[data-testid="cellInnerDiv"]',
].join(',');

function isUnsafeElement(element: Element | null): boolean {
  return !element || Boolean(element.closest(UNSAFE_SELECTOR));
}

function hasUnsafeStyle(element: Element): boolean {
  let current: Element | null = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle?.(current);
    if (
      style &&
      (style.cursor === 'pointer' || style.position === 'fixed' || style.position === 'sticky')
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Busca un punto realmente inerte. Si hay cualquier duda, devuelve null.
 * El clic se dispara sobre <body>, nunca sobre el elemento validado.
 */
function findBlankPoint(): Point | null {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!width || !height) return null;
  if (
    document.querySelector(
      '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]',
    )
  ) {
    return null;
  }

  try {
    const selection = window.getSelection?.();
    if (selection && String(selection).trim()) return null;
  } catch {
    return null;
  }

  const active = document.activeElement as HTMLElement | null;
  if (
    active &&
    (active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.isContentEditable)
  ) {
    return null;
  }

  const points: Point[] = [
    {
      x: width - randomBetween(12, 40),
      y: randomBetween(Math.round(height * 0.2), Math.round(height * 0.85)),
    },
    {
      x: randomBetween(12, 40),
      y: randomBetween(Math.round(height * 0.2), Math.round(height * 0.85)),
    },
    {
      x: randomBetween(Math.round(width * 0.3), Math.round(width * 0.7)),
      y: height - randomBetween(10, 36),
    },
  ];

  for (const point of points) {
    if (point.x <= 0 || point.y <= 0 || point.x >= width || point.y >= height) continue;
    const element = document.elementFromPoint?.(point.x, point.y) as Element | null;
    if (!element) continue;
    const stack: Element[] =
      (document.elementsFromPoint?.(point.x, point.y) as Element[] | undefined) ?? [element];
    if (stack.some((item) => isUnsafeElement(item))) continue;
    if (isUnsafeElement(element) || hasUnsafeStyle(element)) continue;
    return point;
  }
  return null;
}

function dispatchPointerEvent(
  target: Element,
  type: string,
  point: Point,
  buttons: number,
): void {
  if (typeof PointerEvent === 'undefined') return;
  try {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  } catch {
    // Algunos navegadores no permiten construir PointerEvent sintéticos.
  }
}

function dispatchMouseEvent(
  target: Element,
  type: string,
  point: Point,
  buttons: number,
): void {
  if (typeof MouseEvent === 'undefined') return;
  try {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons,
      }),
    );
  } catch {
    // Nunca interrumpir la recolección por un evento sintético.
  }
}

async function movePointerRandomly(): Promise<void> {
  if (typeof MouseEvent === 'undefined' && typeof PointerEvent === 'undefined') return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!width || !height) return;

  const target: Point = {
    x: randomBetween(40, Math.max(41, width - 40)),
    y: randomBetween(80, Math.max(81, height - 80)),
  };
  const from = lastPointer ?? { x: Math.round(width * 0.7), y: Math.round(height * 0.5) };
  const path = planPointerPath(from, target);
  const surface = document.body ?? document.documentElement;
  if (!surface) return;

  for (const point of path) {
    if (stopRequested || paused) return;
    dispatchPointerEvent(surface, 'pointermove', point, 0);
    dispatchMouseEvent(surface, 'mousemove', point, 0);
    await sleep(randomBetween(35, 120));
  }
  lastPointer = target;
}

function tryBlankClick(): boolean {
  const point = findBlankPoint();
  if (!point) return false;
  const surface = document.body;
  if (!surface) return false;

  dispatchPointerEvent(surface, 'pointermove', point, 0);
  dispatchMouseEvent(surface, 'mousemove', point, 0);
  dispatchPointerEvent(surface, 'pointerdown', point, 1);
  dispatchMouseEvent(surface, 'mousedown', point, 1);
  dispatchPointerEvent(surface, 'pointerup', point, 0);
  dispatchMouseEvent(surface, 'mouseup', point, 0);
  dispatchMouseEvent(surface, 'click', point, 0);
  lastPointer = point;
  return true;
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
    case 'navigation_changed':
      return 'La recolección se detuvo al salir de la búsqueda o la lista.';
    default:
      return 'La recolección se detuvo.';
  }
}

async function finish(reason: string, message: string): Promise<void> {
  if (!context) return;
  const ctx = context;
  scraping = false;
  await flushQueue();

  const frontier = currentFrontierMs();
  const seenIso = frontier !== null ? new Date(frontier).toISOString() : null;

  if (ctx.strategy === 'list') {
    const reachedStart =
      reason === 'date_boundary' ||
      listPassReachedStart(frontier, Date.parse(ctx.range.start), boundaryMarginMs);
    await sendBg({
      type: 'LIST_PASS_DONE',
      reason,
      message,
      scrolls,
      captured: currentWindowCaptured,
      oldestSeenAt: seenIso,
      coveredUntilAt: seenIso,
      reachedStart,
    });
  } else {
    const failureReasons = new Set([
      'login_required',
      'rate_limited',
      'page_error',
      'navigation_changed',
    ]);
    if (failureReasons.has(reason)) {
      await sendBg({
        type: 'WINDOW_FAILED',
        windowIndex: ctx.windowIndex,
        reason,
        message,
      });
    } else {
      await sendBg({
        type: 'WINDOW_DONE',
        windowIndex: ctx.windowIndex,
        reason,
        scrolls,
        windowCaptured: currentWindowCaptured,
        oldestSeenAt: seenIso,
      });
    }
  }
  context = null;
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

function postElements<T extends Element>(root: HTMLElement, selector: string): T[] {
  const quote = root.closest('[data-testid="quoteTweet"]');
  return [...root.querySelectorAll<T>(selector)].filter(element => element.closest('[data-testid="quoteTweet"]') === quote);
}

function readDomUrls(root: HTMLElement): string[] {
  const links = postElements<HTMLAnchorElement>(root,
    '[data-testid="tweetText"] a[href], [data-testid="card.wrapper"] a[href], a[data-testid="card.wrapper"][href], a[href*="/i/article/"]');
  return [...new Set(links.map(link => link.href).filter(url => /^https?:\/\//.test(url)))];
}

function readDomMedia(root: HTMLElement): MediaItem[] {
  const media = new Map<string, MediaItem>();
  for (const video of postElements<HTMLVideoElement>(root, 'video')) {
    const url = video.currentSrc || video.src || video.querySelector<HTMLSourceElement>('source[src]')?.src;
    const thumbnail = video.poster || undefined;
    if (url && /^https:\/\/video\.twimg\.com\//.test(url)) {
      media.set(url, { type: 'video', url, thumbnail });
    } else if (thumbnail) {
      media.set(thumbnail, { type: 'video', url: thumbnail, thumbnail });
    }
  }
  for (const image of postElements<HTMLImageElement>(root, 'img[src*="pbs.twimg.com/media"]')) {
    const url = image.getAttribute('src');
    if (!url || media.has(url)) continue;
    const alt = image.getAttribute('alt')?.trim();
    media.set(url, { type: 'photo', url, alt: alt && !/^(image|imagen)$/i.test(alt) ? alt : undefined });
  }
  return [...media.values()];
}

function scrapeDomPosts(): NormalizedPost[] {
  const articles = Array.from(document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  const collectedAt = nowIso();
  const posts = new Map<string, NormalizedPost>();

  for (const article of articles) {
    const [time] = postElements<HTMLTimeElement>(article, 'time[datetime]');
    const createdAtRaw = time?.getAttribute('datetime');
    if (!createdAtRaw) continue;
    const createdMs = Date.parse(createdAtRaw);
    if (!Number.isFinite(createdMs)) continue;

    const links = postElements<HTMLAnchorElement>(article, 'a[href*="/status/"]');
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

    const [userBlock] = postElements<HTMLElement>(article, '[data-testid="User-Name"]');
    const userText = (userBlock?.innerText ?? '').trim();
    const handleMatch = /@([A-Za-z0-9_]+)/.exec(userText);
    const handle = handleMatch?.[1] ?? 'desconocido';
    const name =
      userText
        .split(/\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('@')) ?? handle;

    const [textBlock] = postElements<HTMLElement>(article, '[data-testid="tweetText"]');
    const text = (textBlock?.innerText ?? '').trim();
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

    const quote = article.querySelector<HTMLElement>('[data-testid="quoteTweet"]');
    const quoteUrl = quote && postElements<HTMLAnchorElement>(quote, 'a[href*="/status/"]')[0]?.href;
    const quotedPostId = quoteUrl && postIdFromUrl(quoteUrl) || undefined;
    const quotedText = quote?.querySelector<HTMLElement>('[data-testid="tweetText"]')?.innerText.trim();
    const quotedHandle = quote?.querySelector<HTMLElement>('[data-testid="User-Name"]')?.innerText.match(/@(\w+)/)?.[1];

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
      originalPostId: isRepost ? id : undefined,
      quotedPostId,
      quoted: quote && quotedPostId
        ? { id: quotedPostId, handle: quotedHandle, text: quotedText ?? '', permalink: quoteUrl || undefined,
          urls: readDomUrls(quote), media: readDomMedia(quote) }
        : undefined,
      urls: readDomUrls(article),
      hashtags: [],
      mentions: [],
      media: readDomMedia(article),
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
      captureSource: 'dom',
    });
  }

  return [...posts.values()];
}

function readDomArticle(id: string): PostArticle | undefined {
  const body = document.querySelector<HTMLElement>(
    '[data-testid="twitterArticleRichTextView"], [data-testid="articleRichTextView"]',
  );
  if (!body) return;
  const url = `https://x.com/i/article/${id}`;
  const blocks = readArticleBlocks(body, url);
  const text = articleText(blocks) || body.innerText.trim().slice(0, 40_000);
  if (!text && !blocks.length) return;
  return {
    url,
    title: document.querySelector<HTMLElement>('[data-testid="twitterArticleTitle"], main h1')?.innerText.trim(),
    text,
    blocks,
    blocksFromDetail: true,
  };
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

async function discoverVisibleLists(): Promise<void> {
  if (extensionInvalidated || document.hidden || !isListsIndexPage()) return;
  const lists = scrapeListsFromDom();
  if (lists.length === 0) return;
  const signature = lists.map((list) => `${list.id}:${list.name}`).join('|');
  if (signature === lastListsSignature) return;
  lastListsSignature = signature;
  await upsertLists(lists);
}

async function reportListPageInfo(): Promise<void> {
  if (context || !isListDetailPage()) return;
  const id = location.pathname.match(/\/i\/lists\/(\d+)/)?.[1];
  if (!id) return;

  const pathname = location.pathname;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (location.pathname !== pathname) return;
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
