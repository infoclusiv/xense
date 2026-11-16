import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AiAnalysis } from './ai/analysis';
import type { Transcription } from './ai/transcript';
import type { ListInfo, NormalizedPost, RunRecord, StoredPost } from './types';
import { mergePostContext } from './x/normalize';

interface XenseDB extends DBSchema {
  analyses: {
    key: string;
    value: AiAnalysis;
    indexes: { 'by-run': string };
  };
  lists: {
    key: string;
    value: ListInfo;
    indexes: { 'by-name': string };
  };
  runs: {
    key: string;
    value: RunRecord;
    indexes: { 'by-created': string };
  };
  posts: {
    key: [string, string];
    value: StoredPost;
    indexes: { 'by-run': string; 'by-run-date': [string, string]; 'by-id': string };
  };
  transcripts: {
    key: [string, string];
    value: { runId: string; url: string; transcription: Transcription };
    indexes: { 'by-run': string };
  };
}

let dbPromise: Promise<IDBPDatabase<XenseDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<XenseDB>> {
  if (!dbPromise) {
    dbPromise = openDB<XenseDB>('xense-db', 4, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 2) {
          const analyses = db.createObjectStore('analyses', { keyPath: 'id' });
          analyses.createIndex('by-run', 'runId');
        }
        if (oldVersion < 1) {
          const lists = db.createObjectStore('lists', { keyPath: 'id' });
          lists.createIndex('by-name', 'name');
          const runs = db.createObjectStore('runs', { keyPath: 'id' });
          runs.createIndex('by-created', 'createdAt');
          const posts = db.createObjectStore('posts', { keyPath: ['runId', 'id'] });
          posts.createIndex('by-run', 'runId');
          posts.createIndex('by-run-date', ['runId', 'createdAt']);
        }
        if (oldVersion < 3) tx.objectStore('posts').createIndex('by-id', 'id');
        if (oldVersion < 4) {
          const transcripts = db.createObjectStore('transcripts', { keyPath: ['runId', 'url'] });
          transcripts.createIndex('by-run', 'runId');
        }
      },
    });
  }
  return dbPromise;
}

export async function getLists(): Promise<ListInfo[]> {
  const db = await getDB();
  const lists = await db.getAll('lists');
  return lists.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function getList(id: string): Promise<ListInfo | undefined> {
  const db = await getDB();
  return db.get('lists', id);
}

function isPlaceholderListName(name: string, id: string): boolean {
  return name.trim().toLowerCase() === `lista ${id}`.toLowerCase();
}

export async function upsertLists(newLists: ListInfo[]): Promise<ListInfo[]> {
  if (newLists.length === 0) return getLists();
  const db = await getDB();
  const tx = db.transaction('lists', 'readwrite');
  const store = tx.objectStore('lists');

  for (const incoming of newLists) {
    if (!/^\d+$/.test(incoming.id) || !incoming.name.trim()) continue;
    const existing = await store.get(incoming.id);
    const name =
      existing &&
      isPlaceholderListName(incoming.name, incoming.id) &&
      !isPlaceholderListName(existing.name, existing.id)
        ? existing.name
        : incoming.name;
    const merged: ListInfo = {
      ...existing,
      ...incoming,
      name,
      memberCount: incoming.memberCount ?? existing?.memberCount,
      ownerHandle: incoming.ownerHandle ?? existing?.ownerHandle,
      source: incoming.source === 'manual' && existing ? existing.source : incoming.source,
      updatedAt: incoming.updatedAt || new Date().toISOString(),
    };
    await store.put(merged);
  }

  await tx.done;
  return getLists();
}

export async function saveRun(run: RunRecord): Promise<void> {
  const db = await getDB();
  await db.put('runs', run);
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  const db = await getDB();
  return db.get('runs', id);
}

export async function getRecentRuns(limit = 12): Promise<RunRecord[]> {
  const db = await getDB();
  const tx = db.transaction('runs', 'readonly');
  const index = tx.objectStore('runs').index('by-created');
  const runs: RunRecord[] = [];
  let cursor = await index.openCursor(null, 'prev');
  while (cursor && runs.length < limit) {
    runs.push(cursor.value);
    cursor = await cursor.continue();
  }
  await tx.done;
  return runs;
}

export async function getAllRuns(): Promise<RunRecord[]> {
  const db = await getDB();
  const runs = await db.getAll('runs');
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getLatestRun(): Promise<RunRecord | null> {
  const [latest] = await getRecentRuns(1);
  return latest ?? null;
}

export async function addPosts(
  runId: string,
  windowIndex: number,
  posts: NormalizedPost[],
): Promise<number> {
  if (posts.length === 0) return 0;
  const db = await getDB();
  const tx = db.transaction('posts', 'readwrite');
  const store = tx.objectStore('posts');
  let inserted = 0;

  for (const post of posts) {
    const key: [string, string] = [runId, post.id];
    const existing = await store.get(key);
    const merged = mergePostContext(existing, post);
    const stored: StoredPost = {
      ...merged,
      runId,
      windowIndex: existing?.windowIndex ?? windowIndex,
      createdAt: existing?.createdAt ?? post.createdAt,
    };
    if (!existing || JSON.stringify(existing) !== JSON.stringify(stored)) await store.put(stored);
    if (!existing) inserted += 1;
  }

  await tx.done;
  return inserted;
}

export async function getPostFromHistory(id: string): Promise<NormalizedPost | undefined> {
  const db = await getDB();
  const posts = await db.getAllFromIndex('posts', 'by-id', id);
  return posts.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))
    .reduce<NormalizedPost | undefined>(mergePostContext, undefined);
}

export async function getPostsForRun(runId: string): Promise<StoredPost[]> {
  const db = await getDB();
  const posts = await db.getAllFromIndex('posts', 'by-run', runId);
  return posts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getNewestPostForRun(runId: string): Promise<StoredPost | undefined> {
  const db = await getDB();
  const tx = db.transaction('posts', 'readonly');
  const index = tx.objectStore('posts').index('by-run-date');
  const range = IDBKeyRange.bound([runId, ''], [runId, '\uffff']);
  const cursor = await index.openCursor(range, 'prev');
  await tx.done;
  return cursor?.value;
}

export async function saveAnalysis(analysis: AiAnalysis): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['runs', 'analyses'], 'readwrite');
  if (!await tx.objectStore('runs').getKey(analysis.runId)) {
    await tx.done;
    throw new Error('La recolección se eliminó antes de guardar el análisis.');
  }
  await tx.objectStore('analyses').put(analysis);
  await tx.done;
}

export async function getAnalysesForRun(runId: string): Promise<AiAnalysis[]> {
  const db = await getDB();
  const items = await db.getAllFromIndex('analyses', 'by-run', runId);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSavedTranscript(runId: string, url: string): Promise<Transcription | undefined> {
  const db = await getDB();
  return (await db.get('transcripts', [runId, url]))?.transcription;
}

export async function saveTranscript(runId: string, url: string, transcription: Transcription): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['runs', 'transcripts'], 'readwrite');
  if (await tx.objectStore('runs').getKey(runId)) {
    await tx.objectStore('transcripts').put({ runId, url, transcription });
  }
  await tx.done;
}

export async function deleteRun(runId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['runs', 'posts', 'analyses', 'transcripts'], 'readwrite');
  await tx.objectStore('runs').delete(runId);
  const postsStore = tx.objectStore('posts');
  const index = postsStore.index('by-run');
  let cursor = await index.openCursor(IDBKeyRange.only(runId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  const analysisCursorStore = tx.objectStore('analyses');
  let analysisCursor = await analysisCursorStore.index('by-run').openCursor(IDBKeyRange.only(runId));
  while (analysisCursor) {
    await analysisCursor.delete();
    analysisCursor = await analysisCursor.continue();
  }
  const transcripts = tx.objectStore('transcripts');
  for (const key of await transcripts.index('by-run').getAllKeys(runId)) await transcripts.delete(key);
  await tx.done;
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['lists', 'runs', 'posts', 'analyses', 'transcripts'], 'readwrite');
  await Promise.all([
    tx.objectStore('lists').clear(),
    tx.objectStore('runs').clear(),
    tx.objectStore('posts').clear(),
    tx.objectStore('analyses').clear(),
    tx.objectStore('transcripts').clear(),
  ]);
  await tx.done;
}

export async function getCounts(): Promise<{ lists: number; runs: number; posts: number }> {
  const db = await getDB();
  const [lists, runs, posts] = await Promise.all([
    db.count('lists'),
    db.count('runs'),
    db.count('posts'),
  ]);
  return { lists, runs, posts };
}
