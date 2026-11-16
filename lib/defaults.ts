import type { HumanizeLevel, Settings } from './types';

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
  manualScroll: false,
  humanizeLevel: 'balanced',
  blankClicks: true,
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
    mode: normalizeMode(merged.mode),
    maxPosts: clampNumber(merged.maxPosts, 50, MAX_STORED_POSTS_PER_RUN, fallback.maxPosts),
    minDelayMs: clampNumber(merged.minDelayMs, 1000, 15000, fallback.minDelayMs),
    maxDelayMs: clampNumber(merged.maxDelayMs, 1200, 20000, fallback.maxDelayMs),
    idleScrolls: clampNumber(merged.idleScrolls, 3, 40, fallback.idleScrolls),
    maxScrolls: clampNumber(merged.maxScrolls, 10, 1000, fallback.maxScrolls),
    manualScroll: merged.manualScroll === true,
    humanizeLevel: normalizeHumanizeLevel(merged.humanizeLevel, fallback.humanizeLevel),
    blankClicks:
      typeof merged.blankClicks === 'boolean' ? merged.blankClicks : fallback.blankClicks,
  };
}

function normalizeMode(value: unknown): Settings['mode'] {
  // “timeline” era el nombre antiguo del recorrido de lista.
  if (value === 'search' || value === 'list' || value === 'timeline') {
    return value === 'timeline' ? 'list' : value;
  }
  return 'auto';
}

export function normalizeHumanizeLevel(
  value: unknown,
  fallback: HumanizeLevel = 'balanced',
): HumanizeLevel {
  return value === 'off' || value === 'light' || value === 'balanced' || value === 'careful'
    ? value
    : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
