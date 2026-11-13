import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ListInfo, NormalizedPost, RunRecord, StoredPost } from './types';

interface XenseDB extends DBSchema {
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
    indexes: { 'by-run': string; 'by-run-date': [string, string] };
  };
}

let dbPromise: Promise<IDBPDatabase<XenseDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<XenseDB>> {
  if (!dbPromise) {
    dbPromise = openDB<XenseDB>('xense-db', 1, {
      upgrade(db) {
        const lists = db.createObjectStore('lists', { keyPath: 'id' });
        lists.createIndex('by-name', 'name');
        const runs = db.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('by-created', 'createdAt');
        const posts = db.createObjectStore('posts', { keyPath: ['runId', 'id'] });
        posts.createIndex('by-run', 'runId');
        posts.createIndex('by-run-date', ['runId', 'createdAt']);
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
    if (existing) continue;
    const stored: StoredPost = { ...post, runId, windowIndex };
    await store.put(stored);
    inserted += 1;
  }

  await tx.done;
  return inserted;
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

export async function deleteRun(runId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['runs', 'posts'], 'readwrite');
  await tx.objectStore('runs').delete(runId);
  const postsStore = tx.objectStore('posts');
  const index = postsStore.index('by-run');
  let cursor = await index.openCursor(IDBKeyRange.only(runId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['lists', 'runs', 'posts'], 'readwrite');
  await Promise.all([
    tx.objectStore('lists').clear(),
    tx.objectStore('runs').clear(),
    tx.objectStore('posts').clear(),
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
