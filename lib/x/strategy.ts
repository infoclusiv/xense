import { DateTime } from 'luxon';
import { MAX_RANGE_DAYS } from '../defaults';
import type {
  DateRangeInfo,
  RunMode,
  RunStrategy,
  RunWindow,
  WindowMode,
} from '../types';

/** Un recorrido de lista reciente puede alcanzar el inicio del rango con pocos scrolls. */
export const LIST_PASS_MAX_AGE_DAYS = 30;

/** Si el rango terminó hace días, recorrer la lista desde hoy sería un desperdicio. */
export const LIST_PASS_MAX_END_AGE_DAYS = 2;
export function resolveStartStrategy(
  mode: RunMode,
  range: DateRangeInfo,
  nowInput: Date = new Date(),
): RunStrategy {
  if (mode === 'list') return 'list';
  if (mode === 'search') return 'search';

  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'search';
  const nowMs = nowInput.getTime();
  const startAgeDays = (nowMs - startMs) / 86_400_000;
  const endAgeDays = (nowMs - endMs) / 86_400_000;
  return startAgeDays <= LIST_PASS_MAX_AGE_DAYS && endAgeDays <= LIST_PASS_MAX_END_AGE_DAYS
    ? 'list'
    : 'search';
}

export function buildWindows(range: DateRangeInfo): RunWindow[] {
  const zone = range.timezone;
  const start = DateTime.fromISO(range.start, { setZone: true }).setZone(zone);
  const end = DateTime.fromISO(range.end, { setZone: true }).setZone(zone);
  const baseMode: WindowMode = 'search';
  const windows: RunWindow[] = [];

  let cursor = start;
  let index = 0;
  while (cursor.toMillis() < end.toMillis() && index <= MAX_RANGE_DAYS + 2) {
    const nextDay = cursor.startOf('day').plus({ days: 1 });
    const windowEnd = nextDay.toMillis() < end.toMillis() ? nextDay : end;
    windows.push({
      index,
      start: cursor.toUTC().toISO()!,
      end: windowEnd.toUTC().toISO()!,
      mode: baseMode,
      status: 'pending',
      triedTimeline: false,
      captured: 0,
    });
    cursor = windowEnd;
    index += 1;
  }

  if (windows.length === 0) {
    windows.push({
      index: 0,
      start: start.toUTC().toISO()!,
      end: end.toUTC().toISO()!,
      mode: baseMode,
      status: 'pending',
      triedTimeline: false,
      captured: 0,
    });
  }

  // El modo de la ventana lo decide el run (búsqueda o recorrido de lista).
  return windows;
}

/** Índice de la ventana diaria que contiene una fecha, o -1 si queda fuera. */
export function findWindowIndex(windows: RunWindow[], createdMs: number): number {
  if (!Number.isFinite(createdMs)) return -1;
  let low = 0;
  let high = windows.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const window = windows[middle]!;
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    if (createdMs < startMs) high = middle - 1;
    else if (createdMs >= endMs) low = middle + 1;
    else return window.index;
  }
  return -1;
}

export function firstPendingWindowIndex(windows: RunWindow[], from = 0): number {
  for (let index = Math.max(0, from); index < windows.length; index += 1) {
    if (windows[index]!.status === 'pending') return index;
  }
  return -1;
}

export function nextPendingWindowIndex(windows: RunWindow[], after: number): number {
  return firstPendingWindowIndex(windows, after + 1);
}

/**
 * Ventanas completamente recorridas por un pase de lista.
 * Al desplazarse de lo más nuevo a lo más antiguo, todo lo que empieza
 * después de la fecha confirmada ya se vio.
 */
export function listPassCoveredIndices(windows: RunWindow[], frontierMs: number): number[] {
  if (!Number.isFinite(frontierMs)) return [];
  const covered: number[] = [];
  for (const window of windows) {
    const startMs = Date.parse(window.start);
    if (Number.isFinite(startMs) && startMs >= frontierMs) covered.push(window.index);
  }
  return covered;
}

export function listPassReachedStart(
  frontierMs: number | null,
  rangeStartMs: number,
  marginMs: number,
): boolean {
  if (frontierMs === null || !Number.isFinite(frontierMs)) return false;
  return frontierMs <= rangeStartMs - Math.max(0, marginMs);
}
