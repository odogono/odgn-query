// cache_redis.ts
import SuperJSON from 'superjson';

import { normalizeKey, type AsyncOrSync, type QueryKey } from '.';
import { ONE_MINUTE_IN_MS } from '../helpers/time';

// Minimal interface alignment with QueryCache
export type RedisCacheOptions = {
  defaultTtl?: number; // freshness window in ms
  prefix?: string; // key namespace
  url?: string; // e.g. redis://localhost:6379
};

// Note: Uses Bun.Redis dynamically via consumer choice (QueryClient loads lazily)
type RedisLike = {
  close?: () => Promise<void> | void;
  del: (...keys: string[]) => Promise<unknown> | unknown;
  disconnect?: () => Promise<void> | void;
  get: (key: string) => Promise<string | null> | string | null;
  quit?: () => Promise<void> | void;
  sadd: (key: string, member: string) => Promise<unknown> | unknown;
  set: (key: string, value: string) => Promise<unknown> | unknown;
  smembers: (key: string) => Promise<string[] | null> | string[] | null;
  srem: (key: string, member: string) => Promise<unknown> | unknown;
};

export class RedisQueryCache {
  private redis: RedisLike;
  private readonly prefix: string;
  private readonly defaultTtl: number;
  private readonly refreshing = new Map<string, Promise<unknown>>();

  private constructor(
    redis: RedisLike,
    opts: Required<Omit<RedisCacheOptions, 'url'>>
  ) {
    this.redis = redis;
    this.prefix = opts.prefix;
    this.defaultTtl = opts.defaultTtl;
  }

  static async create(opts: RedisCacheOptions = {}): Promise<RedisQueryCache> {
    const {
      defaultTtl = ONE_MINUTE_IN_MS,
      prefix = 'odgnq',
      url = 'redis://127.0.0.1:6379'
    } = opts;

    // Resolve Redis constructor from Bun at runtime to avoid hard dependency
    const RedisConstructor = (
      globalThis as unknown as {
        Bun?: { Redis?: new (...args: unknown[]) => unknown };
      }
    ).Bun?.Redis;
    if (!RedisConstructor) {
      throw new Error('Redis adapter requires Bun.Redis at runtime');
    }
    const redis = new (RedisConstructor as new (url: string) => unknown)(
      url
    ) as RedisLike;
    return new RedisQueryCache(redis, { defaultTtl, prefix });
  }

  private k(norm: string): string {
    return `${this.prefix}:${norm}`;
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

  async wrap<T>(
    key: QueryKey,
    fn: () => AsyncOrSync<T>,
    ttl: number = this.defaultTtl,
    backgroundRefresh: boolean = true
  ): Promise<T> {
    const norm = normalizeKey(key);
    const now = Date.now();
    const raw = await this.redis.get(this.k(norm));
    const entry = raw
      ? (SuperJSON.parse(raw) as { expiry: number; value: unknown })
      : undefined;

    if (entry) {
      if (now < entry.expiry) {
        return entry.value as T;
      }
      if (backgroundRefresh && !this.refreshing.get(norm)) {
        const p = (async () => {
          try {
            const newVal = await fn();
            const newEntry = { expiry: Date.now() + ttl, value: newVal };
            await this.redis.set(this.k(norm), SuperJSON.stringify(newEntry));
            await this.redis.sadd(`${this.prefix}:index`, norm);
            return newVal;
          } finally {
            this.refreshing.delete(norm);
          }
        })();
        this.refreshing.set(norm, p);
        return entry.value as T; // return stale
      } else {
        const value = await fn();
        const newEntry = { expiry: now + ttl, value };
        await this.redis.set(this.k(norm), SuperJSON.stringify(newEntry));
        await this.redis.sadd(`${this.prefix}:index`, norm);
        return value as T;
      }
    }

    // cache miss
    const value = await fn();
    const newEntry = { expiry: now + ttl, value };
    await this.redis.set(this.k(norm), SuperJSON.stringify(newEntry));
    await this.redis.sadd(`${this.prefix}:index`, norm);
    return value as T;
  }

  async invalidate(key: QueryKey): Promise<void> {
    const norm = normalizeKey(key);
    await this.redis.del(this.k(norm));
    await this.redis.srem(`${this.prefix}:index`, norm);
  }

  async invalidateQueries(prefix: QueryKey): Promise<void> {
    const members: string[] =
      (await this.redis.smembers(`${this.prefix}:index`)) || [];
    for (const norm of members) {
      const k = JSON.parse(norm) as unknown as QueryKey;
      if (this.isKeyPrefixMatch(k, prefix)) {
        await this.redis.del(this.k(norm));
        await this.redis.srem(`${this.prefix}:index`, norm);
      }
    }
  }

  async getEntry(
    key: QueryKey
  ): Promise<{ expiry: number; value: unknown } | undefined> {
    const norm = normalizeKey(key);
    const raw = await this.redis.get(this.k(norm));
    return raw
      ? (SuperJSON.parse(raw) as { expiry: number; value: unknown })
      : undefined;
  }

  async clear(): Promise<void> {
    const idx = `${this.prefix}:index`;
    const members: string[] = (await this.redis.smembers(idx)) || [];
    if (members.length > 0) {
      const keys = members.map(m => this.k(m));
      await this.redis.del(...keys);
      await this.redis.del(idx);
    }
  }

  async set<T>(
    key: QueryKey,
    value: T,
    ttl: number = this.defaultTtl
  ): Promise<void> {
    const norm = normalizeKey(key);
    const entry = { expiry: Date.now() + ttl, value };
    await this.redis.set(this.k(norm), SuperJSON.stringify(entry));
    await this.redis.sadd(`${this.prefix}:index`, norm);
  }

  async close(): Promise<void> {
    const client = this.redis;
    if (typeof client.quit === 'function') {
      await client.quit();
    } else if (typeof client.close === 'function') {
      await client.close();
    } else if (typeof client.disconnect === 'function') {
      await client.disconnect();
    }
  }

  async gc(): Promise<number> {
    const idx = `${this.prefix}:index`;
    const now = Date.now();
    let removed = 0;
    const members: string[] = (await this.redis.smembers(idx)) || [];
    for (const norm of members) {
      const raw = await this.redis.get(this.k(norm));
      if (!raw) {
        await this.redis.srem(idx, norm);
        continue;
      }
      const entry = SuperJSON.parse(raw) as { expiry: number };
      if (entry.expiry <= now) {
        await this.redis.del(this.k(norm));
        await this.redis.srem(idx, norm);
        removed++;
      }
    }
    return removed;
  }
}

export const createRedisQueryCache = (opts: RedisCacheOptions = {}) =>
  RedisQueryCache.create(opts);
