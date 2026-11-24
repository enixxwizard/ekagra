import type {
  FocusSession,
  HabitItem,
  QuickNote,
  ScheduleActivity,
  StudyQuotation,
  TaskItem,
} from '../../types/dayflow';
import type { LibraryResource } from '../../types/library';
import type {
  BlobMetaRecord,
  EkuConversationRecord,
  FileChunkRecord,
  HabitLogRecord,
  ReminderStoreRecord,
  SavedResearchRecord,
  WorkspaceMetaRecord,
} from './types';

export const EKAGRA_DB_NAME = 'ekagra_local_db';
export const EKAGRA_DB_VERSION = 1;

export const STORE_NAMES = {
  WORKSPACE_META: 'workspace_meta',
  ACTIVITIES: 'activities',
  TASKS: 'tasks',
  HABITS: 'habits',
  HABIT_LOGS: 'habit_logs',
  FOCUS_SESSIONS: 'focus_sessions',
  NOTES: 'notes',
  QUOTATIONS: 'quotations',
  LIBRARY_RESOURCES: 'library_resources',
  REMINDERS: 'reminders',
  AI_CONVERSATIONS: 'ai_conversations',
  RESEARCH_RESULTS: 'research_results',
  BLOB_META: 'blob_meta',
  FILE_CHUNKS: 'file_chunks',
} as const;

export type EkagraStoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES];

let dbPromise: Promise<IDBDatabase> | null = null;
const memoryFallbackStores = new Map<EkagraStoreName, Map<string, unknown>>();

function getMemoryMap(storeName: EkagraStoreName): Map<string, unknown> {
  let map = memoryFallbackStores.get(storeName);
  if (!map) {
    map = new Map<string, unknown>();
    memoryFallbackStores.set(storeName, map);
  }
  return map;
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function resetDbConnectionForTests(): void {
  dbPromise = null;
}

export async function openEkagraDb(): Promise<IDBDatabase | null> {
  if (!isIndexedDbAvailable()) return null;
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(EKAGRA_DB_NAME, EKAGRA_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_NAMES.WORKSPACE_META)) {
          db.createObjectStore(STORE_NAMES.WORKSPACE_META, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.ACTIVITIES)) {
          const store = db.createObjectStore(STORE_NAMES.ACTIVITIES, { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.TASKS)) {
          const store = db.createObjectStore(STORE_NAMES.TASKS, { keyPath: 'id' });
          store.createIndex('dueDate', 'dueDate', { unique: false });
          store.createIndex('completed', 'completed', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.HABITS)) {
          db.createObjectStore(STORE_NAMES.HABITS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.HABIT_LOGS)) {
          db.createObjectStore(STORE_NAMES.HABIT_LOGS, { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.FOCUS_SESSIONS)) {
          const store = db.createObjectStore(STORE_NAMES.FOCUS_SESSIONS, { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.NOTES)) {
          const store = db.createObjectStore(STORE_NAMES.NOTES, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.QUOTATIONS)) {
          const store = db.createObjectStore(STORE_NAMES.QUOTATIONS, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.LIBRARY_RESOURCES)) {
          const store = db.createObjectStore(STORE_NAMES.LIBRARY_RESOURCES, { keyPath: 'id' });
          store.createIndex('subject', 'subject', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('fileHash', 'fileHash', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.REMINDERS)) {
          db.createObjectStore(STORE_NAMES.REMINDERS, { keyPath: 'scopeKey' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.AI_CONVERSATIONS)) {
          db.createObjectStore(STORE_NAMES.AI_CONVERSATIONS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.RESEARCH_RESULTS)) {
          const store = db.createObjectStore(STORE_NAMES.RESEARCH_RESULTS, { keyPath: 'id' });
          store.createIndex('topic', 'topic', { unique: false });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.BLOB_META)) {
          const store = db.createObjectStore(STORE_NAMES.BLOB_META, { keyPath: 'key' });
          store.createIndex('kind', 'kind', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_NAMES.FILE_CHUNKS)) {
          const store = db.createObjectStore(STORE_NAMES.FILE_CHUNKS, { keyPath: 'id' });
          store.createIndex('key', 'key', { unique: false });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error('Unable to open local application database.'));
      };
    } catch (err) {
      dbPromise = null;
      reject(err);
    }
  });

  try {
    return await dbPromise;
  } catch {
    return null;
  }
}

function wrapRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function extractKeyFromRecord(storeName: EkagraStoreName, record: unknown): string {
  const obj = record as Record<string, unknown>;
  if (storeName === STORE_NAMES.HABIT_LOGS) return String(obj.date ?? '');
  if (storeName === STORE_NAMES.REMINDERS) return String(obj.scopeKey ?? '');
  if (storeName === STORE_NAMES.BLOB_META) return String(obj.key ?? '');
  return String(obj.id ?? '');
}

export async function idbGet<T>(storeName: EkagraStoreName, key: string): Promise<T | null> {
  const db = await openEkagraDb();
  if (!db) {
    return (getMemoryMap(storeName).get(key) as T | undefined) ?? null;
  }
  const tx = db.transaction(storeName, 'readonly');
  const result = await wrapRequest<T | undefined>(tx.objectStore(storeName).get(key));
  return result ?? null;
}

export async function idbGetAll<T>(storeName: EkagraStoreName): Promise<T[]> {
  const db = await openEkagraDb();
  if (!db) {
    return Array.from(getMemoryMap(storeName).values()) as T[];
  }
  const tx = db.transaction(storeName, 'readonly');
  const result = await wrapRequest<T[]>(tx.objectStore(storeName).getAll());
  return Array.isArray(result) ? result : [];
}

export async function idbPut<T>(storeName: EkagraStoreName, record: T): Promise<void> {
  const db = await openEkagraDb();
  if (!db) {
    getMemoryMap(storeName).set(extractKeyFromRecord(storeName, record), record);
    return;
  }
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(record);
  await wrapTransaction(tx);
}

export async function idbDelete(storeName: EkagraStoreName, key: string): Promise<void> {
  const db = await openEkagraDb();
  if (!db) {
    getMemoryMap(storeName).delete(key);
    return;
  }
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await wrapTransaction(tx);
}

export async function idbReplaceStore<T>(storeName: EkagraStoreName, items: T[]): Promise<void> {
  const db = await openEkagraDb();
  if (!db) {
    const map = getMemoryMap(storeName);
    map.clear();
    for (const item of items) {
      map.set(extractKeyFromRecord(storeName, item), item);
    }
    return;
  }
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  store.clear();
  for (const item of items) {
    store.put(item);
  }
  await wrapTransaction(tx);
}

export async function idbSaveWorkspaceBundle(bundle: {
  meta: WorkspaceMetaRecord;
  activities: ScheduleActivity[];
  tasks: TaskItem[];
  habits: HabitItem[];
  habitLogs: HabitLogRecord[];
  focusSessions: FocusSession[];
  notes: QuickNote[];
  quotations: StudyQuotation[];
}): Promise<void> {
  const db = await openEkagraDb();
  if (!db) {
    getMemoryMap(STORE_NAMES.WORKSPACE_META).set('singleton', bundle.meta);
    await idbReplaceStore(STORE_NAMES.ACTIVITIES, bundle.activities);
    await idbReplaceStore(STORE_NAMES.TASKS, bundle.tasks);
    await idbReplaceStore(STORE_NAMES.HABITS, bundle.habits);
    await idbReplaceStore(STORE_NAMES.HABIT_LOGS, bundle.habitLogs);
    await idbReplaceStore(STORE_NAMES.FOCUS_SESSIONS, bundle.focusSessions);
    await idbReplaceStore(STORE_NAMES.NOTES, bundle.notes);
    await idbReplaceStore(STORE_NAMES.QUOTATIONS, bundle.quotations);
    return;
  }

  const storeList: EkagraStoreName[] = [
    STORE_NAMES.WORKSPACE_META,
    STORE_NAMES.ACTIVITIES,
    STORE_NAMES.TASKS,
    STORE_NAMES.HABITS,
    STORE_NAMES.HABIT_LOGS,
    STORE_NAMES.FOCUS_SESSIONS,
    STORE_NAMES.NOTES,
    STORE_NAMES.QUOTATIONS,
  ];

  const tx = db.transaction(storeList, 'readwrite');
  tx.objectStore(STORE_NAMES.WORKSPACE_META).put(bundle.meta);

  const replaceInTx = <T>(name: EkagraStoreName, items: T[]) => {
    const s = tx.objectStore(name);
    s.clear();
    for (const item of items) {
      s.put(item);
    }
  };

  replaceInTx(STORE_NAMES.ACTIVITIES, bundle.activities);
  replaceInTx(STORE_NAMES.TASKS, bundle.tasks);
  replaceInTx(STORE_NAMES.HABITS, bundle.habits);
  replaceInTx(STORE_NAMES.HABIT_LOGS, bundle.habitLogs);
  replaceInTx(STORE_NAMES.FOCUS_SESSIONS, bundle.focusSessions);
  replaceInTx(STORE_NAMES.NOTES, bundle.notes);
  replaceInTx(STORE_NAMES.QUOTATIONS, bundle.quotations);

  await wrapTransaction(tx);
}

export async function idbGetFileChunksByKey(key: string): Promise<FileChunkRecord[]> {
  const db = await openEkagraDb();
  if (!db) {
    return Array.from(getMemoryMap(STORE_NAMES.FILE_CHUNKS).values())
      .filter((c): c is FileChunkRecord => Boolean(c && (c as FileChunkRecord).key === key))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }
  const tx = db.transaction(STORE_NAMES.FILE_CHUNKS, 'readonly');
  const idx = tx.objectStore(STORE_NAMES.FILE_CHUNKS).index('key');
  const rows = await wrapRequest<FileChunkRecord[]>(idx.getAll(key));
  return (rows ?? []).sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export async function idbDeleteFileChunksByKey(key: string): Promise<void> {
  const db = await openEkagraDb();
  if (!db) {
    const map = getMemoryMap(STORE_NAMES.FILE_CHUNKS);
    for (const [k, v] of map.entries()) {
      if ((v as FileChunkRecord).key === key) map.delete(k);
    }
    return;
  }
  const existing = await idbGetFileChunksByKey(key);
  if (existing.length === 0) return;
  const tx = db.transaction(STORE_NAMES.FILE_CHUNKS, 'readwrite');
  const store = tx.objectStore(STORE_NAMES.FILE_CHUNKS);
  for (const chunk of existing) {
    store.delete(chunk.id);
  }
  await wrapTransaction(tx);
}

export async function idbEstimateAppMetadataBytes(): Promise<number> {
  const [
    meta,
    activities,
    tasks,
    habits,
    habitLogs,
    sessions,
    notes,
    quotations,
    library,
    reminders,
    aiConvs,
    research,
  ] = await Promise.all([
    idbGetAll<WorkspaceMetaRecord>(STORE_NAMES.WORKSPACE_META),
    idbGetAll<ScheduleActivity>(STORE_NAMES.ACTIVITIES),
    idbGetAll<TaskItem>(STORE_NAMES.TASKS),
    idbGetAll<HabitItem>(STORE_NAMES.HABITS),
    idbGetAll<HabitLogRecord>(STORE_NAMES.HABIT_LOGS),
    idbGetAll<FocusSession>(STORE_NAMES.FOCUS_SESSIONS),
    idbGetAll<QuickNote>(STORE_NAMES.NOTES),
    idbGetAll<StudyQuotation>(STORE_NAMES.QUOTATIONS),
    idbGetAll<LibraryResource>(STORE_NAMES.LIBRARY_RESOURCES),
    idbGetAll<ReminderStoreRecord>(STORE_NAMES.REMINDERS),
    idbGetAll<EkuConversationRecord>(STORE_NAMES.AI_CONVERSATIONS),
    idbGetAll<SavedResearchRecord>(STORE_NAMES.RESEARCH_RESULTS),
  ]);

  const json = JSON.stringify({
    meta,
    activities,
    tasks,
    habits,
    habitLogs,
    sessions,
    notes,
    quotations,
    library,
    reminders,
    aiConvs,
    research,
  });

  return new TextEncoder().encode(json).byteLength;
}

export async function idbClearAllStoresExceptBlobs(): Promise<void> {
  const storesToClear: EkagraStoreName[] = [
    STORE_NAMES.WORKSPACE_META,
    STORE_NAMES.ACTIVITIES,
    STORE_NAMES.TASKS,
    STORE_NAMES.HABITS,
    STORE_NAMES.HABIT_LOGS,
    STORE_NAMES.FOCUS_SESSIONS,
    STORE_NAMES.NOTES,
    STORE_NAMES.QUOTATIONS,
    STORE_NAMES.REMINDERS,
    STORE_NAMES.AI_CONVERSATIONS,
    STORE_NAMES.RESEARCH_RESULTS,
  ];
  const db = await openEkagraDb();
  if (!db) {
    for (const s of storesToClear) getMemoryMap(s).clear();
    return;
  }
  const tx = db.transaction(storesToClear, 'readwrite');
  for (const s of storesToClear) {
    tx.objectStore(s).clear();
  }
  await wrapTransaction(tx);
}

export type LibraryResourceStored = LibraryResource & { fileHash?: string | null };

export async function idbGetAllBlobMeta(): Promise<BlobMetaRecord[]> {
  return idbGetAll<BlobMetaRecord>(STORE_NAMES.BLOB_META);
}
