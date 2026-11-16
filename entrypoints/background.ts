import { DateTime } from 'luxon';
import {
  MAX_RANGE_DAYS,
  MAX_STORED_POSTS_PER_RUN,
  SETTINGS_KEY,
  clampSettings,
  normalizeHumanizeLevel,
} from '../lib/defaults';
import {
  addPosts,
  clearAllData,
  deleteRun as deleteRunFromDb,
  getAllRuns,
  getCounts,
  getList,
  getLists,
  getLatestRun,
  getNewestPostForRun,
  getPostsForRun,
  getRecentRuns,
  getRun,
  saveRun,
  upsertLists,
} from '../lib/db';
import { normalizeTimezone } from '../lib/dates/parse';
import { computeRunStats, createProgress, isActiveRun, summarizeRun } from '../lib/runs';
import {
  applyRunToTracking,
  buildContinuationRange,
  buildTrackingFromRuns,
  computeCoverageEnd,
  isWindowCovered,
  toLastCapturedPost,
} from '../lib/tracking';
import type {
  BootstrapData,
  ContentContext,
  DateRangeInfo,
  DiagnosticEntry,
  LastCapturedPost,
  ListInfo,
  ListTracking,
  NormalizedPost,
  RunData,
  RunMode,
  RunRecord,
  RunStrategy,
  RunWindow,
  ScrapeConfig,
  Settings,
  StorageInfo,
  TrackingStore,
} from '../lib/types';
import { ACTIVE_RUN_STATUSES } from '../lib/types';
import {
  buildWindows,
  findWindowIndex,
  firstPendingWindowIndex,
  listPassCoveredIndices,
  nextPendingWindowIndex,
  resolveStartStrategy,
} from '../lib/x/strategy';
import { buildListUrl, buildWindowUrl, extractListId, matchesWindowUrl } from '../lib/x/urls';

const ACTIVE_RUN_KEY = 'xense.activeRunId';
const LAST_LIST_KEY = 'xense.lastListId';
const TRACKING_KEY = 'xense.tracking';

let startingRun = false;
let trackingReady: Promise<void> | null = null;

export default defineBackground(() => {
  void initialize();
  chrome.runtime.onInstalled.addListener(() => {
    void initialize();
  });
  chrome.runtime.onStartup.addListener(() => {
    void reconcileRuns();
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('[Xense] Error en el background:', error);
        sendResponse({ ok: false, error: errorMessage(error) });
      });
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void handleTabRemoved(tabId);
  });
});

async function initialize(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Versiones antiguas de Chromium pueden no exponer sidePanel.
  }
  void ensureTrackingReady().catch((error: unknown) => {
    console.error('[Xense] No se pudo preparar el seguimiento:', error);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // No hay páginas de extensión escuchando.
  });
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  const settings = clampSettings(raw);
  return { ...settings, timezone: normalizeTimezone(settings.timezone) };
}

async function saveSettings(input: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = clampSettings({ ...current, ...input }, current);
  next.timezone = normalizeTimezone(next.timezone);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

async function loadTrackingStore(): Promise<TrackingStore> {
  const stored = await chrome.storage.local.get(TRACKING_KEY);
  const raw = stored[TRACKING_KEY] as Partial<TrackingStore> | undefined;
  if (raw && raw.version === 1 && raw.lists && typeof raw.lists === 'object') {
    return { version: 1, lists: raw.lists as Record<string, ListTracking> };
  }
  return { version: 1, lists: {} };
}

async function saveTrackingStore(store: TrackingStore): Promise<void> {
  await chrome.storage.local.set({ [TRACKING_KEY]: store });
}

function trackingList(store: TrackingStore): ListTracking[] {
  return Object.values(store.lists).sort((a, b) => a.listName.localeCompare(b.listName, 'es'));
}

async function getAllTracking(): Promise<ListTracking[]> {
  const store = await loadTrackingStore();
  return trackingList(store);
}

async function getTrackingForList(listId: string): Promise<ListTracking | null> {
  const store = await loadTrackingStore();
  return store.lists[listId] ?? null;
}

function ensureTrackingReady(): Promise<void> {
  if (!trackingReady) {
    trackingReady = seedTracking().catch((error) => {
      trackingReady = null;
      throw error;
    });
  }
  return trackingReady;
}

async function seedTracking(): Promise<void> {
  const stored = await chrome.storage.local.get(TRACKING_KEY);
  const raw = stored[TRACKING_KEY] as Partial<TrackingStore> | undefined;
  if (raw && raw.version === 1 && raw.lists && typeof raw.lists === 'object') return;

  const runs = await getAllRuns();
  const byList = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (ACTIVE_RUN_STATUSES.includes(run.status)) continue;
    const listId = run.config?.listId;
    if (!listId) continue;
    const listRuns = byList.get(listId) ?? [];
    listRuns.push(run);
    byList.set(listId, listRuns);
  }

  const lists: Record<string, ListTracking> = {};
  for (const [listId, listRuns] of byList) {
    const sorted = [...listRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    let lastPost: LastCapturedPost | null = null;
    for (const run of sorted) {
      if (run.lastCapturedPost) {
        lastPost = run.lastCapturedPost;
        break;
      }
      const post = await getNewestPostForRun(run.id);
      if (post) {
        lastPost = toLastCapturedPost(post);
        break;
      }
    }
    const tracking = buildTrackingFromRuns(listRuns, lastPost);
    if (tracking) lists[listId] = tracking;
  }

  await saveTrackingStore({ version: 1, lists });
}

async function updateTrackingForRun(run: RunRecord): Promise<void> {
  await ensureTrackingReady();
  const store = await loadTrackingStore();
  const existing = store.lists[run.config.listId];
  if (
    !existing &&
    Date.parse(computeCoverageEnd(run)) <= Date.parse(run.config.range.start)
  ) {
    // Un intento que no completó ningún tramo todavía no establece un punto de partida.
    return;
  }
  store.lists[run.config.listId] = applyRunToTracking(existing, run);
  await saveTrackingStore(store);
  broadcast({ type: 'TRACKING_UPDATED', tracking: trackingList(store) });
}

async function resetTracking(listId: string): Promise<ListTracking[]> {
  await ensureTrackingReady();
  const store = await loadTrackingStore();
  delete store.lists[listId];
  await saveTrackingStore(store);
  return trackingList(store);
}

async function setActiveRunId(id: string | null): Promise<void> {
  if (id) await chrome.storage.local.set({ [ACTIVE_RUN_KEY]: id });
  else await chrome.storage.local.remove(ACTIVE_RUN_KEY);
}

async function getActiveRun(): Promise<RunRecord | null> {
  const stored = await chrome.storage.local.get(ACTIVE_RUN_KEY);
  const id = stored[ACTIVE_RUN_KEY] as string | undefined;
  if (id) {
    const run = await getRun(id);
    if (run && ACTIVE_RUN_STATUSES.includes(run.status)) return run;
  }
  const recent = await getRecentRuns(30);
  const fallback = recent.find((run) => ACTIVE_RUN_STATUSES.includes(run.status));
  if (fallback) {
    await setActiveRunId(fallback.id);
    return fallback;
  }
  return null;
}

async function getRunForSender(sender: chrome.runtime.MessageSender): Promise<RunRecord | null> {
  if (sender.frameId !== 0 || !sender.tab?.id) return null;
  const run = await getActiveRun();
  if (!run || sender.tab.id !== run.tabId) return null;
  return run;
}

async function sendToTab(tabId: number | undefined, message: Record<string, unknown>): Promise<void> {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // El content script aún no está listo o la pestaña se cerró.
  }
}

function sanitizeConfig(input: ScrapeConfig, list: ListInfo | undefined, settings: Settings): ScrapeConfig {
  const listId = String(input.listId ?? '').trim();
  if (!/^\d+$/.test(listId)) throw new Error('El ID de la lista no es válido.');

  const timezone = normalizeTimezone(input.range?.timezone || settings.timezone);
  const start = DateTime.fromISO(String(input.range?.start ?? ''), { setZone: true });
  const end = DateTime.fromISO(String(input.range?.end ?? ''), { setZone: true });
  if (!start.isValid || !end.isValid) throw new Error('El rango de fechas no es válido.');
  if (end.toMillis() <= start.toMillis()) throw new Error('El rango termina antes de empezar.');

  const now = DateTime.now();
  if (start.toMillis() > now.toMillis()) throw new Error('La fecha de inicio está en el futuro.');
  if (end.toMillis() > now.plus({ minutes: 5 }).toMillis()) {
    throw new Error('La fecha de fin está en el futuro.');
  }
  if (end.diff(start, 'days').days > MAX_RANGE_DAYS) {
    throw new Error(`El rango máximo es de ${MAX_RANGE_DAYS} días.`);
  }

  const minDelayMs = clamp(input.minDelayMs, 1000, 15000, settings.minDelayMs);
  const maxDelayMs = clamp(input.maxDelayMs, minDelayMs, 20000, settings.maxDelayMs);
  const rangeLabel = String(input.range?.label || 'Rango personalizado').trim();
  const expression = String(input.range?.expression || rangeLabel).trim();

  const range: DateRangeInfo = {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    timezone,
    label: rangeLabel,
    expression,
    partial: Boolean(input.range?.partial),
    rolling: Boolean(input.range?.rolling),
  };

  const mode: RunMode = normalizeMode(input.mode);

  return {
    listId,
    listName: (list?.name || input.listName || `Lista ${listId}`).trim(),
    range,
    mode,
    includeReplies: Boolean(input.includeReplies),
    includeReposts: Boolean(input.includeReposts),
    includeQuotes: Boolean(input.includeQuotes),
    maxPosts: clamp(input.maxPosts, 50, MAX_STORED_POSTS_PER_RUN, settings.maxPosts),
    minDelayMs,
    maxDelayMs,
    idleScrolls: clamp(input.idleScrolls, 3, 40, settings.idleScrolls),
    maxScrolls: clamp(input.maxScrolls, 10, 1000, settings.maxScrolls),
    manualScroll: input.manualScroll ?? settings.manualScroll,
    humanizeLevel: normalizeHumanizeLevel(input.humanizeLevel, settings.humanizeLevel),
    blankClicks:
      typeof input.blankClicks === 'boolean' ? input.blankClicks : settings.blankClicks,
    origin: input.origin === 'continuation' ? 'continuation' : 'manual',
    continuationOfRunId:
      input.origin === 'continuation' && input.continuationOfRunId
        ? String(input.continuationOfRunId)
        : undefined,
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeMode(value: unknown): RunMode {
  if (value === 'search' || value === 'list' || value === 'timeline') {
    return value === 'timeline' ? 'list' : value;
  }
  return 'auto';
}

function runStrategy(run: RunRecord): RunStrategy {
  return run.strategy === 'list' ? 'list' : 'search';
}

async function startRun(input: ScrapeConfig): Promise<{ ok: boolean; run?: RunRecord; error?: string }> {
  if (startingRun) return { ok: false, error: 'Ya se está preparando otra recolección.' };
  startingRun = true;
  try {
    const existing = await getActiveRun();
    if (existing) {
      return {
        ok: false,
        error: `Ya hay una recolección activa para “${existing.config.listName}”. Termínala o cancélala antes de iniciar otra.`,
      };
    }

    const settings = await loadSettings();
    let list = await getList(String(input.listId ?? ''));
    if (!list && /^\d+$/.test(String(input.listId ?? ''))) {
      list = {
        id: String(input.listId),
        name: input.listName || `Lista ${input.listId}`,
        url: buildListUrl(String(input.listId)),
        source: 'manual',
        updatedAt: nowIso(),
      };
      await upsertLists([list]);
    }

    const config = sanitizeConfig(input, list, settings);
    const windows = buildWindows(config.range);
    const strategy = resolveStartStrategy(config.mode, config.range);
    const timestamp = nowIso();
    const run: RunRecord = {
      id: crypto.randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'starting',
      config,
      strategy,
      fallbackStarted: false,
      windows,
      currentWindowIndex: 0,
      captured: 0,
      progress: createProgress(),
      errors: [],
      diagnostics: [],
    };
    if (strategy === 'list') {
      run.diagnostics.push({
        at: timestamp,
        level: 'info',
        message:
          config.mode === 'auto'
            ? 'Recorrido de lista para el rango reciente; la búsqueda queda como respaldo.'
            : 'Recorrido de lista solicitado; sin búsqueda de respaldo.',
      });
    }

    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    if (!tab.id) throw new Error('No se pudo crear la pestaña de recolección.');
    run.tabId = tab.id;

    run.status = 'running';
    run.startedAt = timestamp;
    run.progress = {
      ...createProgress(),
      phase: 'waiting_page',
      message:
        strategy === 'list'
          ? `Abriendo la lista “${config.listName}” y recorriéndola hasta ${config.range.label}…`
          : `Abriendo los resultados de “${config.listName}”…`,
      oldestSeenAt: null,
    };
    await saveRun(run);
    await setActiveRunId(run.id);

    const first = run.windows[0]!;
    const url =
      strategy === 'list'
        ? buildListUrl(config.listId)
        : buildWindowUrl(config.listId, first.start, first.end, 'search');
    try {
      await chrome.tabs.update(tab.id, { url, active: true });
    } catch (updateError) {
      run.status = 'failed';
      run.errors.push(
        `No se pudo abrir la pestaña de recolección: ${errorMessage(updateError)}`,
      );
      run.updatedAt = nowIso();
      await saveRun(run);
      await finalizeRun(run);
      return {
        ok: false,
        run,
        error: 'No se pudo abrir la pestaña de recolección. Comprueba que el navegador permite abrir pestañas.',
      };
    }
    broadcast({ type: 'RUN_STARTED', run });
    return { ok: true, run };
  } finally {
    startingRun = false;
  }
}

async function startContinuationRun(
  input: Partial<ScrapeConfig>,
): Promise<{ ok: boolean; run?: RunRecord; error?: string }> {
  await ensureTrackingReady();
  const listId = String(input.listId ?? '').trim();
  if (!/^\d+$/.test(listId)) {
    return { ok: false, error: 'El ID de la lista no es válido.' };
  }

  const tracking = await getTrackingForList(listId);
  if (!tracking) {
    return {
      ok: false,
      error:
        'Esta lista aún no tiene un análisis previo. Haz primero una recolección con un rango personalizado.',
    };
  }

  const settings = await loadSettings();
  let range: DateRangeInfo;
  try {
    range = buildContinuationRange(tracking, settings.timezone);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  const config: ScrapeConfig = {
    listId,
    listName: input.listName || tracking.listName || `Lista ${listId}`,
    range,
    mode: input.mode ?? settings.mode,
    includeReplies: input.includeReplies ?? settings.includeReplies,
    includeReposts: input.includeReposts ?? settings.includeReposts,
    includeQuotes: input.includeQuotes ?? settings.includeQuotes,
    maxPosts: input.maxPosts ?? settings.maxPosts,
    minDelayMs: input.minDelayMs ?? settings.minDelayMs,
    maxDelayMs: input.maxDelayMs ?? settings.maxDelayMs,
    idleScrolls: input.idleScrolls ?? settings.idleScrolls,
    maxScrolls: input.maxScrolls ?? settings.maxScrolls,
    manualScroll: input.manualScroll ?? settings.manualScroll,
    humanizeLevel: input.humanizeLevel ?? settings.humanizeLevel,
    blankClicks: input.blankClicks ?? settings.blankClicks,
    origin: 'continuation',
    continuationOfRunId: tracking.lastRunId,
  };

  return startRun(config);
}

function toContentContext(run: RunRecord, window: RunWindow, expectedUrl: string): ContentContext {
  const strategy = runStrategy(run);
  const listPass = strategy === 'list';
  return {
    runId: run.id,
    listId: run.config.listId,
    listName: run.config.listName,
    range: run.config.range,
    mode: run.config.mode,
    windowIndex: listPass ? 0 : window.index,
    windowStart: listPass ? run.config.range.start : window.start,
    windowEnd: listPass ? run.config.range.end : window.end,
    windowMode: listPass ? 'list' : 'search',
    expectedUrl,
    strategy,
    paused: run.status === 'paused',
    includeReplies: run.config.includeReplies,
    includeReposts: run.config.includeReposts,
    includeQuotes: run.config.includeQuotes,
    maxPosts: run.config.maxPosts,
    minDelayMs: run.config.minDelayMs,
    maxDelayMs: run.config.maxDelayMs,
    idleScrolls: run.config.idleScrolls,
    maxScrolls: run.config.maxScrolls,
    manualScroll: run.config.manualScroll === true,
    humanizeLevel: run.config.humanizeLevel,
    blankClicks: run.config.blankClicks,
    alreadyCaptured: run.captured,
  };
}

async function handleContentReady(
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; context: ContentContext | null; reason?: string }> {
  const run = await getRunForSender(sender);
  if (!run) return { ok: true, context: null, reason: 'no_active_run' };
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
    return { ok: true, context: null, reason: run.status };
  }

  const strategy = runStrategy(run);
  const window = run.windows[run.currentWindowIndex] ?? run.windows[0];
  if (!window) return { ok: true, context: null, reason: 'no_window' };

  let expectedUrl: string;
  if (strategy === 'list') {
    expectedUrl = buildListUrl(run.config.listId);
  } else {
    if (window.status === 'done' || window.status === 'failed') {
      return { ok: true, context: null, reason: 'advancing' };
    }
    expectedUrl = buildWindowUrl(run.config.listId, window.start, window.end, 'search');
  }

  if (!matchesWindowUrl(sender.url, expectedUrl)) {
    if (run.status !== 'navigating') {
      await markRunAbandoned(run, 'La pestaña dejó de mostrar la búsqueda o la lista de la recolección.');
    }
    return { ok: true, context: null, reason: 'unexpected_url' };
  }

  if (strategy !== 'list') window.status = 'active';
  if (run.status !== 'paused') run.status = 'running';
  run.progress = {
    ...run.progress,
    phase: 'waiting_page',
    message:
      strategy === 'list'
        ? 'Cargando el timeline de la lista y leyendo las fechas…'
        : 'Cargando los resultados de la búsqueda…',
    updatedAt: nowIso(),
  };
  run.updatedAt = nowIso();
  await saveRun(run);
  return { ok: true, context: toContentContext(run, window, expectedUrl) };
}

async function handlePosts(
  message: { windowIndex: number; posts: NormalizedPost[] },
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; inserted?: number; total?: number; stop?: boolean; error?: string }> {
  const run = await getRunForSender(sender);
  if (!run) return { ok: false, error: 'No hay una recolección activa para esta pestaña.' };
  if (!['running', 'paused', 'navigating'].includes(run.status)) {
    return { ok: true, inserted: 0, total: run.captured, stop: true };
  }

  const startMs = Date.parse(run.config.range.start);
  const endMs = Date.parse(run.config.range.end);
  const valid = (Array.isArray(message.posts) ? message.posts : []).filter((post) => {
    if (!post || typeof post.id !== 'string' || !post.id) return false;
    const created = Date.parse(post.createdAt);
    return Number.isFinite(created) && created >= startMs && created < endMs;
  });

  const fallbackWindowIndex = Number.isInteger(message.windowIndex)
    ? Math.max(0, Math.min(run.windows.length - 1, message.windowIndex))
    : run.currentWindowIndex;

  const grouped = new Map<number, NormalizedPost[]>();
  for (const post of valid) {
    const byDate = findWindowIndex(run.windows, Date.parse(post.createdAt));
    const index = byDate >= 0 ? byDate : fallbackWindowIndex;
    const list = grouped.get(index) ?? [];
    list.push(post);
    grouped.set(index, list);
  }

  const newest = valid.reduce<NormalizedPost | null>(
    (latest, post) =>
      !latest || Date.parse(post.createdAt) > Date.parse(latest.createdAt) ? post : latest,
    null,
  );

  let inserted = 0;
  for (const [windowIndex, posts] of grouped) {
    const added = await addPosts(run.id, windowIndex, posts);
    inserted += added;
    const window = run.windows[windowIndex];
    if (window) window.captured += added;
  }

  let snapshotChanged = false;
  if (newest) {
    const snapshot = toLastCapturedPost(newest);
    if (
      !run.lastCapturedPost ||
      Date.parse(snapshot.createdAt) > Date.parse(run.lastCapturedPost.createdAt)
    ) {
      run.lastCapturedPost = snapshot;
      snapshotChanged = true;
    }
  }

  if (inserted > 0) run.captured += inserted;

  if (inserted > 0 || snapshotChanged) {
    run.updatedAt = nowIso();
    await saveRun(run);
    broadcast({ type: 'RUN_UPDATED', run });
  }

  const stop =
    run.captured >= run.config.maxPosts || run.captured >= MAX_STORED_POSTS_PER_RUN;
  return { ok: true, inserted, total: run.captured, stop };
}

function markListCoverage(run: RunRecord, frontier: string | null | undefined): number {
  if (!frontier) return 0;
  const frontierMs = Date.parse(frontier);
  if (!Number.isFinite(frontierMs)) return 0;
  const covered = new Set(listPassCoveredIndices(run.windows, frontierMs));
  let changed = 0;
  for (const window of run.windows) {
    if (!covered.has(window.index)) continue;
    if (window.status !== 'pending' && window.status !== 'active') continue;
    window.status = 'done';
    window.reason = 'list_pass';
    changed += 1;
  }
  return changed;
}

async function handleProgress(
  message: {
    windowIndex: number;
    scrolls: number;
    windowCaptured: number;
    oldestSeenAt: string | null;
    coveredUntilAt?: string | null;
    pageHasResults: boolean;
    hidden: boolean;
    phase: RunRecord['progress']['phase'];
    message: string;
  },
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  const run = await getRunForSender(sender);
  if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return { ok: true };
  const strategy = runStrategy(run);
  if (strategy !== 'list' && message.windowIndex !== run.currentWindowIndex) {
    return { ok: true };
  }

  const covered =
    strategy === 'list' ? markListCoverage(run, message.coveredUntilAt) : 0;

  run.progress = {
    phase: message.phase,
    message: message.message,
    scrolls: Math.max(0, Number(message.scrolls) || 0),
    windowCaptured: Math.max(0, Number(message.windowCaptured) || 0),
    oldestSeenAt: message.oldestSeenAt ?? null,
    pageHasResults: Boolean(message.pageHasResults),
    hidden: Boolean(message.hidden),
    updatedAt: nowIso(),
  };
  run.updatedAt = nowIso();
  await saveRun(run);
  if (covered > 0) broadcast({ type: 'RUN_UPDATED', run });
  return { ok: true };
}

function markRemainingUncovered(run: RunRecord, reason: string): number {
  let changed = 0;
  for (const window of run.windows) {
    if (window.status !== 'pending' && window.status !== 'active') continue;
    window.status = 'done';
    window.reason = reason;
    changed += 1;
  }
  return changed;
}

async function handleWindowDone(
  message: {
    windowIndex: number;
    reason: string;
    scrolls: number;
    windowCaptured: number;
    oldestSeenAt: string | null;
  },
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  const run = await getRunForSender(sender);
  if (!run) return { ok: true };
  if (run.status === 'cancelled') return { ok: true };
  if (message.windowIndex !== run.currentWindowIndex) return { ok: true };

  const window = run.windows[run.currentWindowIndex];
  if (!window) return { ok: true };

  const reason = String(message.reason || 'exhausted');
  if (reason === 'cancelled') return { ok: true };

  const limitReached =
    run.captured >= run.config.maxPosts || run.captured >= MAX_STORED_POSTS_PER_RUN;
  if (limitReached) {
    window.status = 'done';
    window.reason = 'max_posts';
    const skipped = markRemainingUncovered(run, 'skipped_limit');
    run.diagnostics.push({
      at: nowIso(),
      level: 'info',
      message: `Límite de posts alcanzado (${run.captured}). Se omitieron ${skipped} ventanas restantes.`,
    });
    trimDiagnostics(run);
    run.updatedAt = nowIso();
    await saveRun(run);
    await finalizeRun(run);
    return { ok: true };
  }

  const failedReasons = new Set(['login_required', 'rate_limited', 'page_error', 'navigation_error']);
  window.status = failedReasons.has(reason) ? 'failed' : 'done';
  window.reason = reason;
  if (window.status === 'failed') {
    run.errors.push(
      reason === 'login_required'
        ? 'X solicita iniciar sesión. Abre x.com e inicia sesión antes de recolectar.'
        : reason === 'rate_limited'
          ? 'X limitó temporalmente la carga de resultados. Espera un rato y vuelve a intentarlo.'
          : `La ventana ${window.index + 1} falló: ${reason}.`,
    );
  }
  if (window.status === 'failed' || window.captured === 0) {
    run.diagnostics.push({
      at: nowIso(),
      level: window.status === 'failed' ? 'error' : 'warn',
      message: `Ventana ${window.index + 1} terminada con motivo “${reason}” y ${window.captured} posts.`,
    });
    trimDiagnostics(run);
  }

  run.updatedAt = nowIso();
  await saveRun(run);
  await advanceRun(run);
  return { ok: true };
}

async function handleWindowFailed(
  message: { windowIndex: number; reason: string; message: string },
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  const run = await getRunForSender(sender);
  if (!run) return { ok: true };
  if (message.windowIndex !== run.currentWindowIndex) return { ok: true };
  const window = run.windows[run.currentWindowIndex];
  if (!window) return { ok: true };

  window.status = 'failed';
  window.reason = message.reason || 'error';
  run.errors.push(message.message || 'La recolección falló en esta ventana.');
  run.diagnostics.push({
    at: nowIso(),
    level: 'error',
    message: `${message.message || 'Error'} (${message.reason || 'desconocido'})`,
  });
  trimDiagnostics(run);
  run.updatedAt = nowIso();
  if (['rate_limited', 'login_required', 'navigation_changed'].includes(window.reason)) {
    run.status = run.captured > 0 ? 'partial' : 'failed';
    await finalizeRun(run, message.message);
    return { ok: true };
  }
  await saveRun(run);
  await advanceRun(run);
  return { ok: true };
}

async function handleListPassDone(
  message: {
    reason: string;
    message?: string;
    scrolls?: number;
    captured?: number;
    oldestSeenAt: string | null;
    coveredUntilAt?: string | null;
    reachedStart?: boolean;
  },
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  const run = await getRunForSender(sender);
  if (!run) return { ok: true };
  if (runStrategy(run) !== 'list') return { ok: true };
  if (run.status === 'cancelled') return { ok: true };

  const reason = String(message.reason || 'exhausted');
  if (reason === 'cancelled') return { ok: true };

  const frontier = message.coveredUntilAt ?? message.oldestSeenAt ?? null;
  const covered = markListCoverage(run, frontier);
  const reached = Boolean(message.reachedStart) || reason === 'date_boundary';
  if (reached) {
    for (const window of run.windows) {
      if (window.status !== 'pending' && window.status !== 'active') continue;
      window.status = 'done';
      window.reason = 'list_pass';
    }
  }

  run.diagnostics.push({
    at: nowIso(),
    level: reached ? 'info' : 'warn',
    message: reached
      ? 'El recorrido de lista alcanzó el inicio del rango.'
      : `El recorrido de lista terminó antes del inicio del rango (${reason}); ${covered} ventanas recientes cubiertas.`,
  });
  trimDiagnostics(run);

  const limitReached =
    run.captured >= run.config.maxPosts || run.captured >= MAX_STORED_POSTS_PER_RUN;
  if (limitReached) {
    markRemainingUncovered(run, 'max_posts');
    run.updatedAt = nowIso();
    await saveRun(run);
    await finalizeRun(run, 'Se alcanzó el máximo de posts configurado.');
    return { ok: true };
  }

  if (reached) {
    run.updatedAt = nowIso();
    await saveRun(run);
    await finalizeRun(run);
    return { ok: true };
  }

  const fatalReasons = new Set(['login_required', 'rate_limited', 'navigation_changed']);
  if (fatalReasons.has(reason)) {
    const text = message.message || 'El recorrido de lista se interrumpió.';
    run.errors.push(text);
    run.status = run.captured > 0 ? 'partial' : 'failed';
    run.updatedAt = nowIso();
    await saveRun(run);
    await finalizeRun(run, text);
    return { ok: true };
  }

  const pendingCount = run.windows.filter(
    (window) => window.status === 'pending' || window.status === 'active',
  ).length;
  if (pendingCount === 0) {
    run.updatedAt = nowIso();
    await saveRun(run);
    await finalizeRun(run);
    return { ok: true };
  }

  if (run.config.mode === 'auto') {
    const firstIndex = firstPendingWindowIndex(run.windows);
    if (firstIndex < 0) {
      run.updatedAt = nowIso();
      await saveRun(run);
      await finalizeRun(run);
      return { ok: true };
    }

    run.strategy = 'search';
    run.fallbackStarted = true;
    run.currentWindowIndex = firstIndex;
    run.status = 'navigating';
    run.progress = {
      ...createProgress(),
      phase: 'navigating',
      message: `La lista no llegó al inicio del rango. Buscando ${pendingCount} días restantes…`,
      oldestSeenAt: frontier,
    };
    run.diagnostics.push({
      at: nowIso(),
      level: 'info',
      message: `Respaldo de búsqueda para ${pendingCount} ventanas anteriores (${reason}).`,
    });
    trimDiagnostics(run);
    run.updatedAt = nowIso();
    await saveRun(run);
    await sleep(randomDelay(500, 1400));
    await navigateToWindow(run, run.windows[firstIndex]!);
    return { ok: true };
  }

  markRemainingUncovered(run, 'list_incomplete');
  run.errors.push(
    'El recorrido de la lista no alcanzó el inicio del rango. Activa el modo automático para buscar los días restantes.',
  );
  run.updatedAt = nowIso();
  await saveRun(run);
  await finalizeRun(
    run,
    'El recorrido de lista terminó sin alcanzar el inicio del rango. El seguimiento no avanzó.',
  );
  return { ok: true };
}

async function navigateToWindow(run: RunRecord, window: RunWindow): Promise<void> {
  if (!run.tabId) {
    await markRunAbandoned(run, 'La pestaña de recolección ya no existe.');
    return;
  }
  const url = buildWindowUrl(run.config.listId, window.start, window.end, 'search');
  try {
    await chrome.tabs.update(run.tabId, { url });
  } catch (error) {
    window.status = 'failed';
    window.reason = 'navigation_error';
    run.errors.push(`No se pudo abrir la siguiente ventana: ${errorMessage(error)}`);
    await saveRun(run);
    await advanceRun(run);
  }
}

async function advanceRun(run: RunRecord): Promise<void> {
  const nextIndex = nextPendingWindowIndex(run.windows, run.currentWindowIndex);
  if (nextIndex >= 0) {
    run.currentWindowIndex = nextIndex;
    const next = run.windows[nextIndex]!;
    run.status = 'navigating';
    run.progress = {
      ...run.progress,
      phase: 'navigating',
      message: `Preparando la ventana ${nextIndex + 1} de ${run.windows.length}…`,
      updatedAt: nowIso(),
    };
    run.updatedAt = nowIso();
    await saveRun(run);
    // Pausa breve y variable antes de navegar, sin bloquear al service worker.
    await sleep(randomDelay(400, 1200));
    await navigateToWindow(run, next);
    return;
  }

  await finalizeRun(run);
}

function randomDelay(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(1, max - min));
}

async function finalizeRun(run: RunRecord, message?: string): Promise<void> {
  if (!['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) {
    const failed = run.windows.filter((window) => window.status === 'failed').length;
    const active = run.windows.find((window) => window.status === 'active');
    if (active) active.status = 'failed';
    const incomplete = run.windows.filter(
      (window) => window.status !== 'failed' && !isWindowCovered(window),
    ).length;
    run.status =
      run.captured === 0 && failed === run.windows.length && failed > 0
        ? 'failed'
        : failed > 0 || incomplete > 0
          ? 'partial'
          : 'completed';
  }

  run.finishedAt = nowIso();
  run.progress = {
    ...run.progress,
    phase: 'finished',
    message: message ?? (
      run.status === 'cancelled'
        ? 'Recolección cancelada.'
        : run.status === 'failed' && run.errors.length > 0
          ? run.errors[run.errors.length - 1]!
          : run.captured === 0
            ? 'La recolección terminó sin posts dentro del rango.'
            : `Recolección terminada: ${run.captured} posts.`),
    updatedAt: nowIso(),
  };
  run.updatedAt = nowIso();
  await saveRun(run);
  try {
    await updateTrackingForRun(run);
  } catch (error) {
    console.error('[Xense] No se pudo actualizar el seguimiento:', error);
  }
  await setActiveRunId(null);
  broadcast({ type: 'RUN_FINISHED', run, summary: summarizeRun(run) });
}

async function handleTabRemoved(tabId: number): Promise<void> {
  const run = await getActiveRun();
  if (!run || run.tabId !== tabId) return;
  await markRunAbandoned(run, 'La pestaña de recolección se cerró antes de terminar.');
}

async function markRunAbandoned(run: RunRecord, message: string): Promise<void> {
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) return;

  if (runStrategy(run) !== 'list') {
    const window = run.windows[run.currentWindowIndex];
    if (window && window.status !== 'done') {
      window.status = 'failed';
      window.reason = 'abandoned';
    }
  }

  run.status = run.captured > 0 ? 'partial' : 'failed';
  run.errors.push(message);
  run.diagnostics.push({ at: nowIso(), level: 'warn', message });
  trimDiagnostics(run);
  run.progress = {
    ...run.progress,
    phase: 'finished',
    message,
    updatedAt: nowIso(),
  };
  run.updatedAt = nowIso();
  await saveRun(run);
  await finalizeRun(run);
}

async function pauseRun(): Promise<{ ok: boolean; run?: RunRecord; error?: string }> {
  const run = await getActiveRun();
  if (!run) return { ok: false, error: 'No hay una recolección activa.' };
  if (run.status !== 'running') {
    return { ok: false, error: 'La recolección no se puede pausar en este momento.' };
  }
  run.status = 'paused';
  run.progress = { ...run.progress, message: 'Recolección pausada.', updatedAt: nowIso() };
  run.updatedAt = nowIso();
  await saveRun(run);
  await sendToTab(run.tabId, { type: 'SCRAPER_PAUSE' });
  broadcast({ type: 'RUN_UPDATED', run });
  return { ok: true, run };
}

async function resumeRun(): Promise<{ ok: boolean; run?: RunRecord; error?: string }> {
  const run = await getActiveRun();
  if (!run) return { ok: false, error: 'No hay una recolección activa.' };
  if (run.status !== 'paused') return { ok: false, error: 'La recolección no está pausada.' };
  run.status = 'running';
  run.progress = { ...run.progress, message: 'Reanudando la recolección…', updatedAt: nowIso() };
  run.updatedAt = nowIso();
  await saveRun(run);
  await sendToTab(run.tabId, { type: 'SCRAPER_RESUME' });
  broadcast({ type: 'RUN_UPDATED', run });
  return { ok: true, run };
}

async function cancelRun(): Promise<{ ok: boolean; run?: RunRecord; error?: string }> {
  const run = await getActiveRun();
  if (!run) return { ok: false, error: 'No hay una recolección activa.' };
  run.status = 'cancelled';
  run.finishedAt = nowIso();
  run.progress = { ...run.progress, phase: 'finished', message: 'Recolección cancelada.', updatedAt: nowIso() };
  run.updatedAt = nowIso();
  await saveRun(run);
  try {
    await updateTrackingForRun(run);
  } catch (error) {
    console.error('[Xense] No se pudo actualizar el seguimiento al cancelar:', error);
  }
  await sendToTab(run.tabId, { type: 'SCRAPER_STOP' });
  await setActiveRunId(null);
  broadcast({ type: 'RUN_UPDATED', run });
  return { ok: true, run };
}

async function reconcileRuns(): Promise<void> {
  const run = await getActiveRun();
  if (!run) return;
  if (!run.tabId) {
    await markRunAbandoned(run, 'No se encontró la pestaña de recolección.');
    return;
  }
  try {
    await chrome.tabs.get(run.tabId);
  } catch {
    await markRunAbandoned(run, 'La pestaña de recolección ya no existe.');
  }
}

function trimDiagnostics(run: RunRecord): void {
  if (run.diagnostics.length > 200) {
    run.diagnostics = run.diagnostics.slice(-200);
  }
}

async function openListsTab(): Promise<{ ok: true; tabId?: number }> {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const existing = tabs.find((tab) => tab.url?.includes('/i/lists'));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {
        // La ventana puede haber cambiado.
      }
    }
    try {
      // Fuerza la inyección del content script si la pestaña ya estaba abierta.
      await chrome.tabs.reload(existing.id);
    } catch {
      // La pestaña pudo cerrarse.
    }
    return { ok: true, tabId: existing.id };
  }
  const tab = await chrome.tabs.create({ url: 'https://x.com/i/lists', active: true });
  return { ok: true, tabId: tab.id };
}

async function resolveListUrl(url: string): Promise<{ ok: boolean; list?: ListInfo; error?: string }> {
  const id = extractListId(url);
  if (!id) return { ok: false, error: 'No encontré un ID de lista en esa URL.' };
  const existing = await getList(id);
  if (existing && !existing.name.toLowerCase().startsWith('lista ')) {
    return { ok: true, list: existing };
  }
  const provisional: ListInfo = existing ?? {
    id,
    name: `Lista ${id}`,
    url: buildListUrl(id),
    source: 'manual',
    updatedAt: nowIso(),
  };
  await upsertLists([provisional]);
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const existingTab = tabs.find((tab) => tab.url?.includes(`/i/lists/${id}`));
  if (existingTab?.id) {
    await chrome.tabs.update(existingTab.id, { active: true });
    try {
      // Fuerza la inyección del content script y la lectura del nombre de la lista.
      await chrome.tabs.reload(existingTab.id);
    } catch {
      // La pestaña pudo cerrarse.
    }
  } else {
    await chrome.tabs.create({ url: buildListUrl(id), active: true });
  }
  broadcast({ type: 'LISTS_UPDATED' });
  return { ok: true, list: provisional };
}

async function getBootstrap(): Promise<{ ok: true } & BootstrapData> {
  await ensureTrackingReady();
  const [settings, lists, activeRun, recentRecords, tracking] = await Promise.all([
    loadSettings(),
    getLists(),
    getActiveRun(),
    getRecentRuns(30),
    getAllTracking(),
  ]);
  const latestRun = recentRecords[0] ?? (activeRun ? activeRun : await getLatestRun());
  return {
    ok: true,
    settings,
    lists,
    activeRun,
    latestRun,
    recentRuns: recentRecords.map(summarizeRun),
    tracking,
  };
}

async function getRunData(runId: string): Promise<{ ok: boolean; data?: RunData; error?: string }> {
  const run = await getRun(runId);
  if (!run) return { ok: false, error: 'No encontré esa recolección.' };
  const posts = await getPostsForRun(runId);
  const stats = computeRunStats(posts, run.config.range.timezone);
  return { ok: true, data: { run, posts, stats } };
}

async function getStorageInfo(): Promise<StorageInfo> {
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

async function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
): Promise<any> {
  const type = message?.type;

  switch (type) {
    case 'CONTENT_READY':
      return handleContentReady(sender);
    case 'POSTS_BATCH':
      return handlePosts(message, sender);
    case 'PROGRESS':
      return handleProgress(message, sender);
    case 'LIST_PASS_DONE':
      return handleListPassDone(message, sender);
    case 'WINDOW_DONE':
      return handleWindowDone(message, sender);
    case 'WINDOW_FAILED':
      return handleWindowFailed(message, sender);
    case 'PAGE_DIAGNOSTIC': {
      const run = await getRunForSender(sender);
      if (run && message.entry) {
        const entry = message.entry as DiagnosticEntry;
        run.diagnostics.push({
          at: entry.at || nowIso(),
          operation: entry.operation,
          message: String(entry.message ?? '').slice(0, 1000),
          level: entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info',
        });
        trimDiagnostics(run);
        run.updatedAt = nowIso();
        await saveRun(run);
      }
      return { ok: true };
    }
    case 'UPSERT_LISTS': {
      const lists = await upsertLists(Array.isArray(message.lists) ? message.lists : []);
      if (lists.length > 0) broadcast({ type: 'LISTS_UPDATED' });
      return { ok: true, lists };
    }
    case 'LIST_INFO': {
      if (message.list) {
        await upsertLists([message.list as ListInfo]);
        broadcast({ type: 'LISTS_UPDATED' });
      }
      return { ok: true };
    }
    case 'GET_BOOTSTRAP':
      return getBootstrap();
    case 'GET_STATE': {
      await ensureTrackingReady();
      const [activeRun, recentRecords, tracking] = await Promise.all([
        getActiveRun(),
        getRecentRuns(30),
        getAllTracking(),
      ]);
      return {
        ok: true,
        activeRun,
        latestRun: recentRecords[0] ?? null,
        recentRuns: recentRecords.map(summarizeRun),
        tracking,
      };
    }
    case 'GET_SETTINGS': {
      return { ok: true, settings: await loadSettings() };
    }
    case 'SAVE_SETTINGS': {
      const settings = await saveSettings(message.settings ?? {});
      broadcast({ type: 'SETTINGS_UPDATED', settings });
      return { ok: true, settings };
    }
    case 'START_RUN':
      return startRun(message.config as ScrapeConfig);
    case 'START_CONTINUE_RUN':
      return startContinuationRun((message.config ?? {}) as Partial<ScrapeConfig>);
    case 'RESET_TRACKING': {
      const tracking = await resetTracking(String(message.listId ?? ''));
      broadcast({ type: 'TRACKING_UPDATED', tracking });
      return { ok: true, tracking };
    }
    case 'PAUSE_RUN':
      return pauseRun();
    case 'RESUME_RUN':
      return resumeRun();
    case 'CANCEL_RUN':
      return cancelRun();
    case 'GET_RUN': {
      const run = message.runId ? await getRun(message.runId) : await getLatestRun();
      return run ? { ok: true, run } : { ok: false, error: 'No encontré esa recolección.' };
    }
    case 'GET_RUN_DATA':
      return getRunData(String(message.runId ?? ''));
    case 'GET_RECENT_RUNS': {
      const runs = await getRecentRuns(30);
      return { ok: true, runs: runs.map(summarizeRun) };
    }
    case 'DELETE_RUN': {
      const runId = String(message.runId ?? '');
      const active = await getActiveRun();
      if (active?.id === runId) await cancelRun();
      await deleteRunFromDb(runId);
      broadcast({ type: 'RUN_DELETED', runId });
      return { ok: true };
    }
    case 'DELETE_ALL_DATA': {
      await ensureTrackingReady().catch(() => undefined);
      const active = await getActiveRun();
      if (active) await cancelRun();
      await clearAllData();
      await setActiveRunId(null);
      await chrome.storage.local.remove([LAST_LIST_KEY, TRACKING_KEY]);
      trackingReady = null;
      broadcast({ type: 'DATA_CLEARED' });
      broadcast({ type: 'TRACKING_UPDATED', tracking: [] });
      return { ok: true };
    }
    case 'OPEN_LISTS_TAB':
      return openListsTab();
    case 'RESOLVE_LIST_URL':
      return resolveListUrl(String(message.url ?? ''));
    case 'OPEN_DASHBOARD': {
      const runId = String(message.runId ?? '');
      const url = chrome.runtime.getURL(`dashboard.html?runId=${encodeURIComponent(runId)}`);
      const tab = await chrome.tabs.create({ url, active: true });
      return { ok: true, tabId: tab.id };
    }
    case 'FOCUS_SCRAPER_TAB': {
      const run = await getActiveRun();
      if (!run?.tabId) return { ok: false, error: 'No hay una pestaña de recolección abierta.' };
      await chrome.tabs.update(run.tabId, { active: true });
      return { ok: true };
    }
    case 'GET_STORAGE': {
      const [storage, run, counts] = await Promise.all([
        getStorageInfo(),
        getActiveRun(),
        getCounts(),
      ]);
      return { ok: true, storage, activeRun: run, counts };
    }
    case 'PING':
      return { ok: true };
    default:
      return { ok: false, error: `Mensaje no reconocido: ${String(type)}` };
  }
}
