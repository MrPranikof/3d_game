/**
 * IndexedDB cache for generated .glb files — second launch is instant and works offline (PWA).
 * Key = `${variantKey}|${engine}|${quality}|${STYLE_HASH}` so any change of engine, quality tier,
 * style prefix or FACTORY_VERSION invalidates stale entries automatically.
 */

export interface CachedAsset {
  key: string;
  assetId: string;
  bytes: ArrayBuffer;
  meta: Record<string, unknown>;
  createdAt: number;
  size: number;
}

const DB_NAME = 'milsim-asset-cache';
const STORE = 'glb';
const VERSION = 1;

export class GLBCache {
  private dbp: Promise<IDBDatabase> | null = null;
  private memory = new Map<string, CachedAsset>(); // fallback when IndexedDB is unavailable (private mode)

  private open(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('assetId', 'assetId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  async requestPersistence(): Promise<boolean> {
    try {
      return (await navigator.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(key: string): Promise<CachedAsset | undefined> {
    try {
      return (await this.tx<CachedAsset | undefined>('readonly', (s) => s.get(key))) ?? undefined;
    } catch {
      return this.memory.get(key);
    }
  }

  async put(entry: CachedAsset): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.put(entry));
    } catch {
      this.memory.set(entry.key, entry);
    }
  }

  async clear(): Promise<void> {
    this.memory.clear();
    try {
      await this.tx('readwrite', (s) => s.clear());
    } catch {
      /* ignore */
    }
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    try {
      const all = await this.tx<CachedAsset[]>('readonly', (s) => s.getAll());
      return { entries: all.length, bytes: all.reduce((a, e) => a + e.size, 0) };
    } catch {
      const all = [...this.memory.values()];
      return { entries: all.length, bytes: all.reduce((a, e) => a + e.size, 0) };
    }
  }
}
