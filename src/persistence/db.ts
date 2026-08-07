const DB_NAME = 'loopit';
/**
 * Bumped from 1 to 2 to add `blitzRuns` (see `STORES.blitzRuns`) — the only
 * schema change so far since this project's IndexedDB store was introduced.
 * `openDb`'s `onupgradeneeded` re-checks every store with
 * `objectStoreNames.contains` rather than assuming a fresh-vs-upgrade split,
 * so it creates whichever stores are missing regardless of which version a
 * given browser is actually upgrading *from* (0, i.e. brand new, or 1).
 */
const DB_VERSION = 2;

export const STORES = {
  /**
   * Vestigial: used to hold the daily-puzzle unlock gate (`ProgressRecord`)
   * before the seed-based `PuzzleId` restructuring removed the whole
   * daily-rotation/unlock-gating mechanic (see `puzzleGen.ts`'s doc
   * comment) — nothing reads or writes it any more. Left defined (rather
   * than dropped, which would need an IndexedDB version bump + an
   * `onupgradeneeded` migration to actually delete the store) since an
   * unused, empty object store costs nothing to leave in place.
   */
  progress: 'progress',
  inProgress: 'inProgress',
  completed: 'completed',
  /**
   * One record per finished (or forfeited) Blitz run — see
   * `persistence/blitzStore.ts`'s `BlitzRunRecord`. Unlike `inProgress`,
   * there's no "in-progress Blitz run" record at all: a Blitz run is only
   * ever written here once it ends (timer hits zero or the player
   * forfeits), so refreshing mid-run simply forfeits it with nothing saved
   * — see CLAUDE.md's "Blitz mode" section for why that's an intentional
   * scope cut rather than an oversight.
   */
  blitzRuns: 'blitzRuns',
} as const;

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.progress)) {
          db.createObjectStore(STORES.progress, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.inProgress)) {
          db.createObjectStore(STORES.inProgress, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.completed)) {
          db.createObjectStore(STORES.completed, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.blitzRuns)) {
          db.createObjectStore(STORES.blitzRuns, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Only for tests: forces the next openDb() call to open a fresh connection. */
export function resetDbConnectionForTests(): void {
  dbPromise = null;
}

/** Only for tests: empties every store without tearing down the (shared, fake-indexeddb) database connection. */
export async function clearAllStoresForTests(): Promise<void> {
  const db = await openDb();
  const storeNames = Object.values(STORES);
  const tx = db.transaction(storeNames, 'readwrite');
  for (const name of storeNames) tx.objectStore(name).clear();
  await promisifyTransaction(tx);
}

export async function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const result = await promisifyRequest(tx.objectStore(storeName).get(key));
  return result as T | undefined;
}

export async function putRecord<T>(storeName: string, record: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(record);
  await promisifyTransaction(tx);
}

export async function deleteRecord(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await promisifyTransaction(tx);
}

export async function getAllRecords<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const result = await promisifyRequest(tx.objectStore(storeName).getAll());
  return result as T[];
}
