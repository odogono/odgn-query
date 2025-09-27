// queryClient.ts
import mitt from 'mitt';

import { QueryCache, type QueryKey } from './cache';
import { createLog } from './helpers/log';
import { ONE_MINUTE_IN_MS } from './helpers/time';

type AsyncOrSync<T> = Promise<T> | T;

type MutationFn<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => AsyncOrSync<TResult>;

type MutationOptions<TArgs extends unknown[], TResult> = {
  invalidate?: (result: TResult, args: TArgs) => QueryKey[];
  key: string;
  mutationFn: MutationFn<TArgs, TResult>;
};

export type EventData = {
  key?: QueryKey;
  meta?: unknown;
  ts: number;
  type: string;
};

type QueryResult<T> = {
  data?: T;
  error?: Error;
};

type CacheLike = {
  clear: () => Promise<void> | void;
  getEntry: (
    key: QueryKey
  ) => Promise<{ expiry: number } | undefined> | { expiry: number } | undefined;
  invalidate: (key: QueryKey) => Promise<void> | void;
  invalidateQueries: (prefix: QueryKey) => Promise<void> | void;
  wrap: <T>(
    key: QueryKey,
    fn: () => AsyncOrSync<T>,
    ttl?: number,
    backgroundRefresh?: boolean
  ) => Promise<T>;
};

export type QueryClientOptions = {
  cache?: 'lru' | 'redis' | 'sqlite';
  logging?: boolean; // default true
  redis?: {
    defaultTtl?: number;
    prefix?: string;
    url?: string;
  };
  sqlite?: {
    defaultTtl?: number;
    namespace?: string;
    path?: string;
  };
};

const log = createLog('QueryClient');

export class QueryClient {
  cache: CacheLike;
  private logging: boolean;
  private emitter = mitt<Record<string, unknown>>();
  private initPromise?: Promise<void>;
  private pending?: Promise<void>;

  constructor({
    cache = 'lru',
    logging = true,
    redis,
    sqlite
  }: QueryClientOptions = {}) {
    this.logging = logging;

    if (cache === 'redis') {
      // Lazily load Redis adapter to keep browser compatibility
      this.cache = new QueryCache({
        defaultTtl: ONE_MINUTE_IN_MS,
        maxSize: 500
      });
      this.initPromise = (async () => {
        const mod = await import('./cache/redis');
        this.cache = await mod.createRedisQueryCache({
          defaultTtl: redis?.defaultTtl ?? ONE_MINUTE_IN_MS,
          prefix: redis?.prefix,
          url: redis?.url
        });
      })();
    } else if (cache === 'sqlite') {
      // Lazily load SQLite adapter
      this.cache = new QueryCache({
        defaultTtl: ONE_MINUTE_IN_MS,
        maxSize: 500
      });
      this.initPromise = (async () => {
        const mod = await import('./cache/sqlite');
        this.cache = await mod.createSqliteQueryCache({
          defaultTtl: sqlite?.defaultTtl ?? ONE_MINUTE_IN_MS,
          namespace: sqlite?.namespace,
          path: sqlite?.path
        });
      })();
    } else {
      this.cache = new QueryCache({
        defaultTtl: ONE_MINUTE_IN_MS,
        maxSize: 500
      });
    }

    // default logger → console
    if (this.logging) {
      this.emitter.on('event', (e: unknown) => {
        const event = e as EventData;
        log.info(
          `[QueryClient] ${event.type}`,
          event.key ?? '',
          event.meta ?? ''
        );
      });
    }
  }

  private async ensureReady() {
    if (this.initPromise) {
      await this.initPromise;
    }
    if (this.pending) {
      await this.pending;
      this.pending = undefined;
    }
  }

  private enqueue(op: Promise<void>) {
    this.pending = (this.pending ?? Promise.resolve())
      .then(() => op)
      .catch(() => {});
  }

  private emitEvent(type: string, key?: QueryKey, meta?: unknown) {
    this.emitter.emit('event', {
      key,
      meta,
      ts: Date.now(),
      type
    } as EventData);
  }

  // ---------------- QUERIES ----------------
  async query<T>(opts: {
    backgroundRefresh?: boolean;
    queryFn: () => AsyncOrSync<T>;
    queryKey: QueryKey;
    ttl?: number;
  }): Promise<QueryResult<T>> {
    const { backgroundRefresh, queryFn, queryKey, ttl } = opts;

    await this.ensureReady();

    const entry = await this.cache.getEntry(queryKey);
    if (!entry) {
      this.emitEvent('MISS', queryKey);
    } else if (Date.now() < entry.expiry) {
      this.emitEvent('HIT', queryKey);
    } else {
      this.emitEvent('STALE→SWR', queryKey);
    }

    try {
      const result = await this.cache.wrap(
        queryKey,
        async () => {
          this.emitEvent('FETCH', queryKey);
          return queryFn();
        },
        ttl,
        backgroundRefresh
      );
      return { data: result };
    } catch (error) {
      this.emitEvent('ERROR', queryKey, error);
      return { error: error as Error };
    }
  }

  // ---------------- MUTATIONS ----------------
  mutation<TArgs extends unknown[], TResult>(
    opts: MutationOptions<TArgs, TResult>
  ) {
    const { invalidate, key, mutationFn } = opts;

    return async (...args: TArgs): Promise<TResult> => {
      await this.ensureReady();
      this.emitEvent('MUTATION_START', [key], { args });
      const result = await mutationFn(...args);

      if (invalidate) {
        for (const k of invalidate(result, args)) {
          this.emitEvent('INVALIDATE', k);
          const p = Promise.resolve(this.cache.invalidateQueries(k)).then(
            () => {}
          );
          this.enqueue(p);
        }
      }

      this.emitEvent('MUTATION_COMPLETE', [key]);
      return result;
    };
  }

  invalidate(key: QueryKey) {
    this.emitEvent('INVALIDATE', key);
    const p = Promise.resolve(this.cache.invalidate(key)).then(() => {});
    this.enqueue(p);
  }

  invalidateQueries(prefix: QueryKey) {
    this.emitEvent('INVALIDATE_BRANCH', prefix);
    const p = Promise.resolve(this.cache.invalidateQueries(prefix)).then(
      () => {}
    );
    this.enqueue(p);
  }

  clear() {
    this.emitEvent('CLEAR_ALL');
    const p = Promise.resolve(this.cache.clear()).then(() => {});
    this.enqueue(p);
  }

  async clearAll(): Promise<void> {
    this.emitEvent('CLEAR_ALL');
    await this.ensureReady();
    await Promise.resolve(this.cache.clear());
  }

  on(event: string, handler: (data: unknown) => void) {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (data: unknown) => void) {
    this.emitter.off(event, handler);
  }
}

// Export global instance
export const queryClient = new QueryClient({ logging: true });
