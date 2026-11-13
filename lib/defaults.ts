import type { Settings } from './types';

export const BROWSER_TIMEZONE =
  (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();

export const DEFAULT_SETTINGS: Settings = {
  timezone: BROWSER_TIMEZONE,
  mode: 'auto',
  includeReplies: true,
  includeReposts: true,
  includeQuotes: true,
  maxPosts: 5000,
  minDelayMs: 2200,
  maxDelayMs: 4200,
  idleScrolls: 8,
  maxScrolls: 150,
};

export const MAX_RANGE_DAYS = 180;
export const MAX_STORED_POSTS_PER_RUN = 20000;

export const SETTINGS_KEY = 'xense.settings';
export const LAST_LIST_KEY = 'xense.lastListId';

export function clampSettings(input: Partial<Settings> | undefined, fallback: Settings = DEFAULT_SETTINGS): Settings {
  const merged = { ...fallback, ...(input ?? {}) };
  return {
    ...merged,
    timezone: typeof merged.timezone === 'string' && merged.timezone ? merged.timezone : fallback.timezone,
    mode: merged.mode === 'search' || merged.mode === 'timeline' ? merged.mode : 'auto',
    maxPosts: clampNumber(merged.maxPosts, 50, MAX_STORED_POSTS_PER_RUN, fallback.maxPosts),
    minDelayMs: clampNumber(merged.minDelayMs, 1000, 15000, fallback.minDelayMs),
    maxDelayMs: clampNumber(merged.maxDelayMs, 1200, 20000, fallback.maxDelayMs),
    idleScrolls: clampNumber(merged.idleScrolls, 3, 40, fallback.idleScrolls),
    maxScrolls: clampNumber(merged.maxScrolls, 10, 1000, fallback.maxScrolls),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
