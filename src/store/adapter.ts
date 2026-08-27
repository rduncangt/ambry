/**
 * Storage adapter (PLAN.md §3): the whole dataset is one versioned JSON
 * document behind this interface. localStorage today; IndexedDB slots in
 * behind the same interface if quota ever bites. This seam is also where a
 * future sync change-queue hangs.
 */

export interface StorageAdapter {
  /** Raw JSON string for a key, or null. Must not throw on missing. */
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** All keys currently present (used to list snapshots). */
  keys(): string[];
}

/** Main document key. */
export const DOC_KEY = "ambry.doc";
/** Snapshot keys: ambry.snapshot.<reason> (pre-import, pre-migrate-vN). */
export const SNAPSHOT_PREFIX = "ambry.snapshot.";

export function localStorageAdapter(ls: Storage = window.localStorage): StorageAdapter {
  return {
    get: (k) => ls.getItem(k),
    set: (k, v) => ls.setItem(k, v),
    remove: (k) => ls.removeItem(k),
    keys: () => {
      const out: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k !== null) out.push(k);
      }
      return out;
    },
  };
}

/** In-memory adapter for tests. */
export function memoryAdapter(initial?: Record<string, string>): StorageAdapter {
  const m = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}
