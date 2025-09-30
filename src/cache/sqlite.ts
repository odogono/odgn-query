// cache_sqlite.ts
import { Database } from 'bun:sqlite';
import SuperJSON from 'superjson';

import { normalizeKey, type AsyncOrSync, type QueryKey } from '.';
import { ONE_MINUTE_IN_MS } from '../helpers/time';

export type SqliteCacheOptions = {
  defaultTtl?: number; // freshness window in ms
  namespace?: string; // scope multiple caches in same DB
  path?: string; // ':memory:' or file path
};

export class SqliteQueryCache {
  private db: Database;
  private readonly ns: string;
  private readonly defaultTtl: number;
  private readonly refreshing = new Map<string, Promise<unknown>>();

  private constructor(db: Database, ns: string, defaultTtl: number) {
    this.db = db;
    this.ns = ns;
    this.defaultTtl = defaultTtl;
    this.prepare();
  }

  static async create(
    opts: SqliteCacheOptions = {}
  ): Promise<SqliteQueryCache> {
    const {
      defaultTtl = ONE_MINUTE_IN_MS,
      namespace = 'odgnq',
      path = ':memory:'
    } = opts;
    const db = new Database(path);
    return new SqliteQueryCache(db, namespace, defaultTtl);
  }

  private prepare() {
    this.db
      .query(
        `CREATE TABLE IF NOT EXISTS odgnq_cache (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      )`
      )
      .run();
    this.db
      .query(
        'CREATE INDEX IF NOT EXISTS odgnq_cache_expiry_idx ON odgnq_cache(namespace, expiry)'
      )
      .run();
  }

  private prefixLike(prefix: QueryKey): string {
    const norm = JSON.stringify(prefix);
    // match any array that starts with the prefix elements followed by a comma
    return norm.slice(0, -1) + ',%';
  }

  async wrap<T>(
    key: QueryKey,
    fn: () => AsyncOrSync<T>,
    ttl: number = this.defaultTtl,
    backgroundRefresh: boolean = true
  ): Promise<T> {
    const norm = normalizeKey(key);
    const now = Date.now();
    const row = this.db
      .query(
        'SELECT expiry, value FROM odgnq_cache WHERE namespace=?1 AND key=?2'
      )
      .get(this.ns, norm) as { expiry: number; value: string } | undefined;

    if (row) {
      if (now < row.expiry) {
        return SuperJSON.parse(row.value) as T;
      }
      if (backgroundRefresh && !this.refreshing.get(norm)) {
        const p = (async () => {
          try {
            const newVal = await fn();
            const value = SuperJSON.stringify(newVal);
            const expiry = Date.now() + ttl;
            this.db
              .query(
                `INSERT INTO odgnq_cache(namespace,key,expiry,value) VALUES(?1,?2,?3,?4)
                ON CONFLICT(namespace,key) DO UPDATE SET expiry=excluded.expiry, value=excluded.value`
              )
              .run(this.ns, norm, expiry, value);
            return newVal;
          } finally {
            this.refreshing.delete(norm);
          }
        })();
        this.refreshing.set(norm, p);
        return SuperJSON.parse(row.value) as T; // stale
      } else {
        const valueObj = await fn();
        const value = SuperJSON.stringify(valueObj);
        const expiry = now + ttl;
        this.db
          .query(
            `INSERT INTO odgnq_cache(namespace,key,expiry,value) VALUES(?1,?2,?3,?4)
             ON CONFLICT(namespace,key) DO UPDATE SET expiry=excluded.expiry, value=excluded.value`
          )
          .run(this.ns, norm, expiry, value);
        return valueObj as T;
      }
    }

    // miss
    const valueObj = await fn();
    const value = SuperJSON.stringify(valueObj);
    const expiry = now + ttl;
    this.db
      .query(
        `INSERT INTO odgnq_cache(namespace,key,expiry,value) VALUES(?1,?2,?3,?4)
         ON CONFLICT(namespace,key) DO UPDATE SET expiry=excluded.expiry, value=excluded.value`
      )
      .run(this.ns, norm, expiry, value);
    return valueObj as T;
  }

  async invalidate(key: QueryKey): Promise<void> {
    const norm = normalizeKey(key);
    this.db
      .query('DELETE FROM odgnq_cache WHERE namespace=?1 AND key=?2')
      .run(this.ns, norm);
  }

  async invalidateQueries(prefix: QueryKey): Promise<void> {
    const norm = JSON.stringify(prefix);
    const like = this.prefixLike(prefix);
    this.db
      .query(
        `DELETE FROM odgnq_cache WHERE namespace=?1 AND (key=?2 OR key LIKE ?3)`
      )
      .run(this.ns, norm, like);
  }

  async getEntry(
    key: QueryKey
  ): Promise<{ expiry: number; value: unknown } | undefined> {
    const norm = normalizeKey(key);
    const row = this.db
      .query(
        `SELECT expiry, value FROM odgnq_cache WHERE namespace=?1 AND key=?2`
      )
      .get(this.ns, norm) as { expiry: number; value: string } | undefined;
    return row
      ? { expiry: row.expiry, value: SuperJSON.parse(row.value) }
      : undefined;
  }

  async clear(): Promise<void> {
    this.db.query('DELETE FROM odgnq_cache WHERE namespace=?1').run(this.ns);
  }

  async set<T>(
    key: QueryKey,
    value: T,
    ttl: number = this.defaultTtl
  ): Promise<void> {
    const norm = normalizeKey(key);
    const entry = SuperJSON.stringify(value);
    const expiry = Date.now() + ttl;
    this.db
      .query(
        `INSERT INTO odgnq_cache(namespace,key,expiry,value) VALUES(?1,?2,?3,?4)
         ON CONFLICT(namespace,key) DO UPDATE SET expiry=excluded.expiry, value=excluded.value`
      )
      .run(this.ns, norm, expiry, entry);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async gc(): Promise<number> {
    const now = Date.now();
    const row = this.db
      .query(
        'SELECT COUNT(*) as cnt FROM odgnq_cache WHERE namespace=?1 AND expiry<=?2'
      )
      .get(this.ns, now) as { cnt: number } | undefined;
    const count = row ? Number(row.cnt) : 0;
    this.db
      .query('DELETE FROM odgnq_cache WHERE namespace=?1 AND expiry<=?2')
      .run(this.ns, now);
    return count;
  }
}

export const createSqliteQueryCache = (opts: SqliteCacheOptions = {}) =>
  SqliteQueryCache.create(opts);
