// cache.ts
import { LRUCache } from 'lru-cache';

import { ONE_MINUTE_IN_MS } from '../helpers/time';

export type QueryKey = readonly (
  | string
  | number
  | boolean
  | null
  | undefined
)[]; // like TanStack
export type AsyncOrSync<T> = Promise<T> | T;

export type CacheOptions = {
  defaultTtl?: number; // ms: how long entry is considered fresh
  maxSize?: number;
};

export type CacheEntry<T> = {
  expiry: number; // timestamp when entry becomes stale
  refreshing?: Promise<T>; // track ongoing background refresh
  value: T;
};

export const normalizeKey = (key: QueryKey): string => JSON.stringify(key);

// Public cache adapter contract used by QueryClient and adapters
export type CacheAdapter = {
  clear: () => Promise<void> | void;
  close?: () => Promise<void> | void;
  gc?: () => Promise<number> | number; // returns number of removed entries
  getEntry: (
    key: QueryKey
  ) =>
    | Promise<{ expiry: number; value: unknown } | undefined>
    | { expiry: number; value: unknown }
    | undefined;
  invalidate: (key: QueryKey) => Promise<void> | void;
  invalidateQueries: (prefix: QueryKey) => Promise<void> | void;
  set?: <T>(key: QueryKey, value: T, ttl?: number) => Promise<void> | void;
  wrap: <T>(
    key: QueryKey,
    fn: () => AsyncOrSync<T>,
    ttl?: number,
    backgroundRefresh?: boolean
  ) => Promise<T>;
};

/**
 * QueryCache is a simple cache that can be used to cache the results of a query.
 */
export class QueryCache {
  private cache: LRUCache<string, CacheEntry<unknown>>;
  private inflight = new Map<string, Promise<unknown>>();

  constructor({
    defaultTtl = ONE_MINUTE_IN_MS,
    maxSize = 500
  }: CacheOptions = {}) {
    this.cache = new LRUCache<string, CacheEntry<unknown>>({ max: maxSize });
    this.defaultTtl = defaultTtl;
  }

  private defaultTtl: number;

  async wrap<T>(
    key: QueryKey,
    fn: () => AsyncOrSync<T>,
    ttl: number = this.defaultTtl,
    backgroundRefresh: boolean = true
  ): Promise<T> {
    const norm = normalizeKey(key);
    const now = Date.now();
    const entry = this.cache.get(norm);

    if (entry) {
      // entry still fresh → return as-is
      if (now < entry.expiry) {
        return entry.value as T;
      }

      // entry stale
      if (backgroundRefresh && !entry.refreshing) {
        // return old value but refresh in background
        entry.refreshing = (async () => {
          try {
            const newVal = await fn();
            this.cache.set(norm, {
              expiry: Date.now() + ttl,
              value: newVal
            });
            return newVal;
          } finally {
            entry.refreshing = undefined;
          }
        })();
        return entry.value as T;
      } else {
        // no background refresh → compute fresh value
        const value = await fn();
        this.cache.set(norm, {
          expiry: now + ttl,
          value
        });
        return value;
      }
    }

    // no entry → coalesce concurrent misses
    const existing = this.inflight.get(norm) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const p = (async () => {
      try {
        const value = await fn();
        this.cache.set(norm, {
          expiry: now + ttl,
          value
        });
        return value as T;
      } finally {
        this.inflight.delete(norm);
      }
    })();
    this.inflight.set(norm, p as Promise<unknown>);
    return p;
  }

  invalidate(key: QueryKey): void {
    this.cache.delete(normalizeKey(key));
  }

  invalidateQueries(prefix: QueryKey): void {
    for (const k of this.cache.keys()) {
      const key = JSON.parse(k) as unknown as QueryKey;
      if (this.isKeyPrefixMatch(key, prefix)) {
        this.cache.delete(k);
      }
    }
  }

  private isKeyPrefixMatch(key: QueryKey, prefix: QueryKey): boolean {
    if (prefix.length === 0) {
      return true;
    }
    if (key.length < prefix.length) {
      return false;
    }

    for (let i = 0; i < prefix.length; i++) {
      if (key[i] !== prefix[i]) {
        return false;
      }
    }
    return true;
  }

  // in cache.ts (the SWR-enabled QueryCache version)
  getEntry(key: QueryKey) {
    const e = this.cache.get(normalizeKey(key));
    return e ? { expiry: e.expiry, value: e.value } : undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  set<T>(key: QueryKey, value: T, ttl: number = this.defaultTtl): void {
    const norm = normalizeKey(key);
    const now = Date.now();
    this.cache.set(norm, { expiry: now + ttl, value });
  }

  close(): void {}

  gc(): number {
    const now = Date.now();
    let removed = 0;
    for (const k of this.cache.keys()) {
      const entry = this.cache.get(k);
      if (entry && entry.expiry <= now) {
        this.cache.delete(k);
        removed++;
      }
    }
    return removed;
  }
}

export const createQueryCache = () =>
  new QueryCache({
    defaultTtl: ONE_MINUTE_IN_MS, // 1 minute by default
    maxSize: 500
  });
