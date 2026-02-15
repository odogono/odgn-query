// cache_redis.ts
import SuperJSON from 'superjson';

import {
  isKeyPrefixMatch,
  normalizeKey,
  type AsyncOrSync,
  type QueryKey
} from '.';
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
  expire: (key: string, seconds: number) => Promise<unknown> | unknown;
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
  private readonly inflight = new Map<string, Promise<unknown>>();
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

  /** SET value and apply a Redis-level EXPIRE as a safety net for stale entries */
  private async setWithTtl(
    redisKey: string,
    value: string,
    ttlMs: number
  ): Promise<void> {
    await this.redis.set(redisKey, value);
    // Use 2x TTL (minimum 60s) so Redis auto-evicts even if gc() never runs
    const expireSec = Math.max(60, Math.ceil((ttlMs * 2) / 1000));
    await this.redis.expire(redisKey, expireSec);
  }

  async findMatchingKeys(
    matcher: QueryKey | QueryKey[] | ((key: QueryKey) => boolean)
  ): Promise<QueryKey[]> {
    const idx = `${this.prefix}:index`;
    const members: string[] = (await this.redis.smembers(idx)) || [];
    const keys = members.map(m => JSON.parse(m) as QueryKey);

    if (typeof matcher === 'function') {
      return keys.filter(k => matcher(k));
    }
    if (
      Array.isArray(matcher) &&
      matcher.length > 0 &&
      Array.isArray(matcher[0])
    ) {
      const want = new Set((matcher as QueryKey[]).map(k => JSON.stringify(k)));
      return keys.filter(k => want.has(JSON.stringify(k)));
    }
    // prefix
    return keys.filter(k => isKeyPrefixMatch(k, matcher as QueryKey));
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
            await this.setWithTtl(
              this.k(norm),
              SuperJSON.stringify(newEntry),
              ttl
            );
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
        await this.setWithTtl(this.k(norm), SuperJSON.stringify(newEntry), ttl);
        await this.redis.sadd(`${this.prefix}:index`, norm);
        return value as T;
      }
    }

    // cache miss — coalesce concurrent requests
    const existing = this.inflight.get(norm) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const p = (async () => {
      try {
        const value = await fn();
        const newEntry = { expiry: now + ttl, value };
        await this.setWithTtl(this.k(norm), SuperJSON.stringify(newEntry), ttl);
        await this.redis.sadd(`${this.prefix}:index`, norm);
        return value as T;
      } finally {
        this.inflight.delete(norm);
      }
    })();
    this.inflight.set(norm, p as Promise<unknown>);
    return p;
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
      if (isKeyPrefixMatch(k, prefix)) {
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
    await this.setWithTtl(this.k(norm), SuperJSON.stringify(entry), ttl);
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
