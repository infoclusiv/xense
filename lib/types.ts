export type RunStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'navigating'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type RunMode = 'auto' | 'search' | 'timeline';
export type RunOrigin = 'manual' | 'continuation';

export interface LastCapturedPost {
  id: string;
  createdAt: string;
  authorHandle: string;
  permalink: string;
  text: string;
}

export interface ListTracking {
  listId: string;
  listName: string;
  cursor: string;
  lastRunId: string;
  lastRunAt: string;
  lastFinishedAt?: string;
  lastStatus: RunStatus;
  lastRangeStart: string;
  lastRangeEnd: string;
  lastRangeLabel: string;
  lastCaptured: number;
  lastPost: LastCapturedPost | null;
  updatedAt: string;
}

export interface TrackingStore {
  version: 1;
  lists: Record<string, ListTracking>;
}
export type WindowMode = 'search' | 'timeline';
export type WindowStatus = 'pending' | 'active' | 'done' | 'failed';
export type PostType = 'original' | 'reply' | 'quote' | 'repost';

export const ACTIVE_RUN_STATUSES: RunStatus[] = ['starting', 'running', 'paused', 'navigating'];

export interface ListInfo {
  id: string;
  name: string;
  memberCount?: number;
  ownerHandle?: string;
  url: string;
  source: 'dom' | 'graphql' | 'manual';
  updatedAt: string;
}

export interface DateRangeInfo {
  start: string;
  end: string;
  timezone: string;
  expression: string;
  label: string;
  partial: boolean;
  rolling: boolean;
}

export interface ScrapeConfig {
  listId: string;
  listName: string;
  range: DateRangeInfo;
  mode: RunMode;
  includeReplies: boolean;
  includeReposts: boolean;
  includeQuotes: boolean;
  maxPosts: number;
  minDelayMs: number;
  maxDelayMs: number;
  idleScrolls: number;
  maxScrolls: number;
  origin?: RunOrigin;
  continuationOfRunId?: string;
}

export interface RunWindow {
  index: number;
  start: string;
  end: string;
  mode: WindowMode;
  status: WindowStatus;
  triedTimeline: boolean;
  captured: number;
  reason?: string;
}

export interface RunProgress {
  phase: 'preparing' | 'waiting_page' | 'scrolling' | 'navigating' | 'finished';
  message: string;
  scrolls: number;
  windowCaptured: number;
  oldestSeenAt: string | null;
  pageHasResults: boolean;
  hidden: boolean;
  updatedAt: string;
}

export interface DiagnosticEntry {
  at: string;
  operation?: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export interface RunRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: RunStatus;
  config: ScrapeConfig;
  windows: RunWindow[];
  currentWindowIndex: number;
  tabId?: number;
  captured: number;
  progress: RunProgress;
  errors: string[];
  diagnostics: DiagnosticEntry[];
  lastCapturedPost?: LastCapturedPost | null;
}

export interface Author {
  id?: string;
  handle: string;
  name: string;
  verified?: boolean;
}

export interface QuotedPost {
  id: string;
  handle?: string;
  name?: string;
  text: string;
  createdAt?: string;
  permalink?: string;
}

export interface MediaItem {
  type: 'photo' | 'video' | 'gif' | 'unknown';
  url: string;
  thumbnail?: string;
  alt?: string;
}

export interface PostMetrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  views: number;
  bookmarks: number;
}

export interface NormalizedPost {
  id: string;
  createdAt: string;
  author: Author;
  text: string;
  lang?: string;
  type: PostType;
  isReply: boolean;
  isRepost: boolean;
  isQuote: boolean;
  replyToHandle?: string;
  repostedBy?: Author | null;
  originalCreatedAt?: string;
  quoted?: QuotedPost | null;
  urls: string[];
  hashtags: string[];
  mentions: string[];
  media: MediaItem[];
  metrics: PostMetrics;
  permalink: string;
  collectedAt: string;
}

export interface StoredPost extends NormalizedPost {
  runId: string;
  windowIndex: number;
}

export interface Settings {
  timezone: string;
  mode: RunMode;
  includeReplies: boolean;
  includeReposts: boolean;
  includeQuotes: boolean;
  maxPosts: number;
  minDelayMs: number;
  maxDelayMs: number;
  idleScrolls: number;
  maxScrolls: number;
}

export type RunSummaryStatus = RunStatus;

export interface RunSummary {
  id: string;
  listId: string;
  listName: string;
  status: RunStatus;
  origin: RunOrigin;
  createdAt: string;
  finishedAt?: string;
  rangeLabel: string;
  captured: number;
  windowsDone: number;
  windowsTotal: number;
  lastPostAt: string | null;
}

export interface RunStats {
  total: number;
  authors: number;
  byType: Record<PostType, number>;
  oldest: string | null;
  newest: string | null;
  days: Array<{ day: string; count: number }>;
  topAuthors: Array<{ handle: string; name: string; count: number }>;
}

export interface RunData {
  run: RunRecord;
  posts: NormalizedPost[];
  stats: RunStats;
}

export interface BootstrapData {
  settings: Settings;
  lists: ListInfo[];
  activeRun: RunRecord | null;
  latestRun: RunRecord | null;
  recentRuns: RunSummary[];
  tracking: ListTracking[];
}

export interface StorageInfo {
  usage: number;
  quota: number;
}

export interface ContentContext {
  runId: string;
  listId: string;
  listName: string;
  range: DateRangeInfo;
  mode: RunMode;
  windowIndex: number;
  windowStart: string;
  windowEnd: string;
  windowMode: WindowMode;
  paused: boolean;
  includeReplies: boolean;
  includeReposts: boolean;
  includeQuotes: boolean;
  maxPosts: number;
  minDelayMs: number;
  maxDelayMs: number;
  idleScrolls: number;
  maxScrolls: number;
  alreadyCaptured: number;
}

export type ContentToBackgroundMessage =
  | { type: 'CONTENT_READY' }
  | {
      type: 'POSTS_BATCH';
      windowIndex: number;
      posts: NormalizedPost[];
    }
  | {
      type: 'PROGRESS';
      windowIndex: number;
      scrolls: number;
      windowCaptured: number;
      oldestSeenAt: string | null;
      pageHasResults: boolean;
      hidden: boolean;
      phase: RunProgress['phase'];
      message: string;
    }
  | {
      type: 'WINDOW_DONE';
      windowIndex: number;
      reason: string;
      scrolls: number;
      windowCaptured: number;
      oldestSeenAt: string | null;
    }
  | {
      type: 'WINDOW_FAILED';
      windowIndex: number;
      reason: string;
      message: string;
    }
  | {
      type: 'PAGE_DIAGNOSTIC';
      entry: DiagnosticEntry;
    }
  | { type: 'UPSERT_LISTS'; lists: ListInfo[] }
  | { type: 'LIST_INFO'; list: ListInfo };
