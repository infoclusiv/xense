import { DateTime } from 'luxon';
import type {
  PostType,
  RunRecord,
  RunStats,
  RunSummary,
  NormalizedPost,
  RunProgress,
} from './types';

export function isActiveRun(run: RunRecord | null | undefined): boolean {
  return Boolean(
    run && ['starting', 'running', 'paused', 'navigating'].includes(run.status),
  );
}

export function createProgress(): RunProgress {
  return {
    phase: 'preparing',
    message: 'Preparando la recolección…',
    scrolls: 0,
    windowCaptured: 0,
    oldestSeenAt: null,
    pageHasResults: false,
    hidden: false,
    updatedAt: new Date().toISOString(),
  };
}

export function summarizeRun(run: RunRecord): RunSummary {
  const windowsDone = run.windows.filter((window) => window.status === 'done').length;
  return {
    id: run.id,
    listId: run.config.listId,
    listName: run.config.listName,
    status: run.status,
    origin: run.config.origin ?? 'manual',
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    rangeLabel: run.config.range.label,
    captured: run.captured,
    windowsDone,
    windowsTotal: run.windows.length,
    lastPostAt: run.lastCapturedPost?.createdAt ?? null,
  };
}

export function computeRunStats(posts: NormalizedPost[], timezone: string): RunStats {
  const byType: Record<PostType, number> = {
    original: 0,
    reply: 0,
    quote: 0,
    repost: 0,
  };
  const authors = new Map<string, { handle: string; name: string; count: number }>();
  const days = new Map<string, number>();
  let oldest: string | null = null;
  let newest: string | null = null;

  for (const post of posts) {
    byType[post.type] += 1;
    const author = post.author;
    const key = author.handle.toLowerCase();
    const existing = authors.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      authors.set(key, { handle: author.handle, name: author.name, count: 1 });
    }

    const local = DateTime.fromISO(post.createdAt, { setZone: true }).setZone(timezone);
    const day = local.toISODate();
    if (day) days.set(day, (days.get(day) ?? 0) + 1);

    if (!oldest || post.createdAt < oldest) oldest = post.createdAt;
    if (!newest || post.createdAt > newest) newest = post.createdAt;
  }

  return {
    total: posts.length,
    authors: authors.size,
    byType,
    oldest,
    newest,
    days: [...days.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    topAuthors: [...authors.values()]
      .sort((a, b) => b.count - a.count || a.handle.localeCompare(b.handle))
      .slice(0, 10),
  };
}

export function getWindowProgress(run: RunRecord): number {
  if (run.windows.length === 0) return 0;
  const current = run.windows[run.currentWindowIndex];
  const done = run.windows.filter((window) => window.status === 'done').length;
  if (run.status === 'completed' || run.status === 'partial') return 1;
  if (!current || current.status !== 'active') return done / run.windows.length;
  return Math.min(0.99, (done + 0.5) / run.windows.length);
}
