import { DateTime } from 'luxon';
import { MAX_RANGE_DAYS } from './defaults';
import { formatLocalDateTime, normalizeTimezone } from './dates/parse';
import { ACTIVE_RUN_STATUSES } from './types';
import type {
  DateRangeInfo,
  LastCapturedPost,
  ListTracking,
  NormalizedPost,
  RunRecord,
  RunWindow,
} from './types';

export const MIN_CONTINUATION_MS = 60_000;

const UNCOVERED_REASONS = new Set([
  'max_scrolls',
  'max_posts',
  'cancelled',
  'skipped_limit',
]);

export class TrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackingError';
  }
}

export function isWindowCovered(window: RunWindow): boolean {
  return window.status === 'done' && !UNCOVERED_REASONS.has(window.reason ?? '');
}

/**
 * Devuelve el final del tramo contiguo que quedó completamente cubierto.
 * Si la primera ventana no se completó, devuelve el inicio del rango.
 */
export function computeCoverageEnd(run: RunRecord): string {
  let coveredUntil = run.config.range.start;
  for (const window of run.windows) {
    if (!isWindowCovered(window)) break;
    coveredUntil = window.end;
  }
  return coveredUntil;
}

/**
 * Calcula el nuevo cursor sin retroceder nunca.
 * Solo avanza si el run empieza en el cursor o antes y cubre más allá de él.
 */
export function nextCursorForRun(
  existing: ListTracking | null | undefined,
  run: RunRecord,
): string {
  const coverageEnd = computeCoverageEnd(run);
  if (!existing) return coverageEnd;

  const cursorMs = Date.parse(existing.cursor);
  const coverageMs = Date.parse(coverageEnd);
  const startMs = Date.parse(run.config.range.start);

  if (!Number.isFinite(cursorMs) || !Number.isFinite(coverageMs) || !Number.isFinite(startMs)) {
    return existing.cursor;
  }
  if (coverageMs <= cursorMs) return existing.cursor;
  if (startMs > cursorMs) return existing.cursor;
  return coverageEnd;
}

export function pickNewestPost(
  a: LastCapturedPost | null,
  b: LastCapturedPost | null,
): LastCapturedPost | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.createdAt) >= Date.parse(a.createdAt) ? b : a;
}

export function toLastCapturedPost(post: NormalizedPost): LastCapturedPost {
  return {
    id: post.id,
    createdAt: post.createdAt,
    authorHandle: post.author.handle,
    permalink: post.permalink,
    text: post.text.replace(/\s+/g, ' ').trim().slice(0, 180),
  };
}

export function applyRunToTracking(
  existing: ListTracking | null | undefined,
  run: RunRecord,
): ListTracking {
  const cursor = nextCursorForRun(existing, run);
  const lastPost = pickNewestPost(existing?.lastPost ?? null, run.lastCapturedPost ?? null);
  const runIsLatest = !existing || Date.parse(run.createdAt) >= Date.parse(existing.lastRunAt);

  return {
    listId: run.config.listId,
    listName: runIsLatest ? run.config.listName : existing!.listName,
    cursor,
    lastRunId: runIsLatest ? run.id : existing!.lastRunId,
    lastRunAt: runIsLatest ? run.createdAt : existing!.lastRunAt,
    lastFinishedAt: runIsLatest
      ? (run.finishedAt ?? run.updatedAt)
      : existing!.lastFinishedAt,
    lastStatus: runIsLatest ? run.status : existing!.lastStatus,
    lastRangeStart: runIsLatest ? run.config.range.start : existing!.lastRangeStart,
    lastRangeEnd: runIsLatest ? run.config.range.end : existing!.lastRangeEnd,
    lastRangeLabel: runIsLatest ? run.config.range.label : existing!.lastRangeLabel,
    lastCaptured: runIsLatest ? run.captured : existing!.lastCaptured,
    lastPost,
    updatedAt: run.updatedAt,
  };
}

/**
 * Reconstruye el seguimiento de una lista a partir de recolecciones antiguas.
 * Para el cursor toma la mayor cobertura conocida; es una aproximación segura
 * para empezar a usar la función con historial ya existente.
 */
export function buildTrackingFromRuns(
  runs: RunRecord[],
  latestPost?: LastCapturedPost | null,
): ListTracking | null {
  const finalized = runs.filter((run) => !ACTIVE_RUN_STATUSES.includes(run.status));
  if (finalized.length === 0) return null;

  const sorted = [...finalized].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = sorted[sorted.length - 1]!;
  let lastPost = latestPost ?? null;

  for (const run of sorted) {
    lastPost = pickNewestPost(lastPost, run.lastCapturedPost ?? null);
  }

  // Se avanza solo por cobertura contigua: si dos recolecciones antiguas dejan
  // un hueco entre ellas, el cursor se detiene antes del hueco en vez de saltarlo.
  const intervals = sorted
    .map((run) => ({
      start: Date.parse(run.config.range.start),
      end: Date.parse(computeCoverageEnd(run)),
    }))
    .filter(
      (interval) =>
        Number.isFinite(interval.start) &&
        Number.isFinite(interval.end) &&
        interval.end > interval.start,
    )
    .sort((a, b) => a.start - b.start);

  if (intervals.length === 0) return null;

  let cursorMs = intervals[0]!.start;
  for (const interval of intervals) {
    if (interval.start > cursorMs) break;
    cursorMs = Math.max(cursorMs, interval.end);
  }
  const cursor = new Date(cursorMs).toISOString();

  return {
    listId: latest.config.listId,
    listName: latest.config.listName,
    cursor,
    lastRunId: latest.id,
    lastRunAt: latest.createdAt,
    lastFinishedAt: latest.finishedAt ?? latest.updatedAt,
    lastStatus: latest.status,
    lastRangeStart: latest.config.range.start,
    lastRangeEnd: latest.config.range.end,
    lastRangeLabel: latest.config.range.label,
    lastCaptured: latest.captured,
    lastPost,
    updatedAt: latest.updatedAt,
  };
}

export function buildContinuationRange(
  tracking: ListTracking | null | undefined,
  timezone: string,
  nowInput: Date | DateTime = new Date(),
): DateRangeInfo {
  if (!tracking?.cursor) {
    throw new TrackingError(
      'Esta lista aún no tiene un análisis previo. Elige un rango personalizado para empezar.',
    );
  }

  const zone = normalizeTimezone(timezone);
  const now =
    nowInput instanceof DateTime ? nowInput : DateTime.fromJSDate(nowInput, { zone: 'utc' });
  const cursor = DateTime.fromISO(tracking.cursor, { setZone: true });

  if (!cursor.isValid) {
    throw new TrackingError(
      'El punto de continuación guardado no es válido. Reinicia el seguimiento de esta lista.',
    );
  }

  const diffMs = now.toMillis() - cursor.toMillis();
  if (diffMs <= 0) {
    throw new TrackingError(
      'Ya estás al día: no ha pasado tiempo desde el último análisis. Vuelve cuando haya nuevos posts.',
    );
  }
  if (diffMs < MIN_CONTINUATION_MS) {
    throw new TrackingError(
      'Ya estás al día: espera un momento antes de recolectar novedades.',
    );
  }

  const days = now.diff(cursor, 'days').days;
  if (days > MAX_RANGE_DAYS) {
    throw new TrackingError(
      `Han pasado ${Math.ceil(days)} días desde el último análisis y el máximo por recolección es de ${MAX_RANGE_DAYS}. Usa un rango personalizado para dividir el periodo.`,
    );
  }

  return {
    start: cursor.toUTC().toISO()!,
    end: now.toUTC().toISO()!,
    timezone: zone,
    expression: 'novedades',
    label: `Novedades desde ${formatLocalDateTime(tracking.cursor, zone)}`,
    partial: false,
    rolling: false,
  };
}
