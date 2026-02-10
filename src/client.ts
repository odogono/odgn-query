// queryClient.ts
import mitt from 'mitt';

import {
  QueryCache,
  normalizeKey,
  type CacheAdapter,
  type QueryKey
} from './cache';
import { createLog } from './helpers/log';
import { ONE_MINUTE_IN_MS } from './helpers/time';

type AsyncOrSync<T> = Promise<T> | T;

type MutationFn<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => AsyncOrSync<TResult>;

type MutationOptions<TArgs extends unknown[], TResult> = {
  key: string;
  mutationFn: MutationFn<TArgs, TResult>;
  onError?: (
    error: Error,
    args: TArgs,
    context?: unknown
  ) => Promise<void> | void;
  onMutate?: (args: TArgs) => Promise<unknown> | unknown;
  onSettled?: (
    data: TResult | undefined,
    error: Error | null,
    args: TArgs,
    context?: unknown
  ) => Promise<void> | void;
  onSuccess?: (
    data: TResult,
    args: TArgs,
    context?: unknown
  ) => Promise<void> | void;
};

type MutationObject<TArgs extends unknown[], TResult> = {
  isError: boolean;
  isSuccess: boolean;
  mutate: (...args: TArgs) => Promise<TResult>;
  mutateAsync: (...args: TArgs) => Promise<TResult>;
};

export type EventData = BaseEvent;

export type QueryResult<T> = {
  data?: T;
  error?: Error;
};

export type QueryClientOptions = {
  // Provide a custom adapter instance or async factory to decouple from environment
  adapter?: CacheAdapter;
  adapterFactory?: () => Promise<CacheAdapter>;
  cache?: 'lru' | 'redis' | 'sqlite';
  defaultBackgroundRefresh?: boolean;
  defaultTtl?: number;
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
  cache: CacheAdapter;
  private logging: boolean;
  private emitter = mitt<EventMap>();
  private initPromise?: Promise<void>;
  private pending?: Promise<void>;
  // Registry to retain query functions per key across adapters
  private queryFnRegistry = new Map<string, () => AsyncOrSync<unknown>>();
  private defaults = {
    backgroundRefresh: true,
    ttl: ONE_MINUTE_IN_MS
  };
  private _stats = {
    errors: 0,
    fetches: 0,
    hits: 0,
    misses: 0,
    stale: 0
  };

  constructor({
    adapter,
    adapterFactory,
    cache = 'lru',
    defaultBackgroundRefresh,
    defaultTtl,
    logging = true,
    redis,
    sqlite
  }: QueryClientOptions = {}) {
    this.logging = logging;
    if (defaultTtl !== undefined) {
      this.defaults.ttl = defaultTtl;
    }
    if (defaultBackgroundRefresh !== undefined) {
      this.defaults.backgroundRefresh = defaultBackgroundRefresh;
    }

    if (adapter) {
      this.cache = adapter;
    } else if (adapterFactory) {
      // temporarily use in-memory until factory resolves
      this.cache = new QueryCache({
        defaultTtl: this.defaults.ttl,
        maxSize: 500
      });
      this.initPromise = (async () => {
        this.cache = await adapterFactory();
      })();
    } else if (cache === 'redis') {
      // Lazily load Redis adapter to keep browser compatibility
      this.cache = new QueryCache({
        defaultTtl: this.defaults.ttl,
        maxSize: 500
      });
      this.initPromise = (async () => {
        const mod = await import('./cache/redis');
        this.cache = await mod.createRedisQueryCache({
          defaultTtl: redis?.defaultTtl ?? this.defaults.ttl,
          prefix: redis?.prefix,
          url: redis?.url
        });
      })();
    } else if (cache === 'sqlite') {
      // Lazily load SQLite adapter
      this.cache = new QueryCache({
        defaultTtl: this.defaults.ttl,
        maxSize: 500
      });
      this.initPromise = (async () => {
        const mod = await import('./cache/sqlite');
        this.cache = await mod.createSqliteQueryCache({
          defaultTtl: sqlite?.defaultTtl ?? this.defaults.ttl,
          namespace: sqlite?.namespace,
          path: sqlite?.path
        });
      })();
    } else {
      this.cache = new QueryCache({
        defaultTtl: this.defaults.ttl,
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

  private enqueue(op: () => Promise<void>) {
    this.pending = (this.pending ?? Promise.resolve()).then(op).catch(() => {});
  }

  private emitEvent(type: EventType, key?: QueryKey, meta?: unknown) {
    const ev: BaseEvent = { key, meta, ts: Date.now(), type };
    // track simple counters
    if (type === 'HIT') {
      this._stats.hits++;
    } else if (type === 'MISS') {
      this._stats.misses++;
    } else if (type === 'STALE→SWR') {
      this._stats.stale++;
    } else if (type === 'FETCH') {
      this._stats.fetches++;
    } else if (type === 'ERROR') {
      this._stats.errors++;
    }
    this.emitter.emit(type, ev);
    this.emitter.emit('event', ev);
  }

  // ---------------- QUERIES ----------------
  async query<T>(opts: {
    backgroundRefresh?: boolean;
    queryFn: () => AsyncOrSync<T>;
    queryKey: QueryKey;
    ttl?: number;
  }): Promise<QueryResult<T>> {
    const backgroundRefresh =
      opts.backgroundRefresh ?? this.defaults.backgroundRefresh;
    const { queryFn, queryKey } = opts;
    const ttl = opts.ttl ?? this.defaults.ttl;

    await this.ensureReady();

    // Remember the query function for refetch across adapters
    this.queryFnRegistry.set(
      normalizeKey(queryKey),
      queryFn as () => AsyncOrSync<unknown>
    );

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

  // Direct cache access helpers
  async getQueryData<T>(key: QueryKey): Promise<T | undefined> {
    await this.ensureReady();
    const entry = await this.cache.getEntry(key);
    return entry ? (entry.value as T) : undefined;
  }

  async setQueryData<T>(key: QueryKey, value: T, ttl?: number): Promise<void> {
    await this.ensureReady();
    await (this.cache.set
      ? this.cache.set<T>(key, value, ttl ?? this.defaults.ttl)
      : this.cache
          .wrap<T>(key, () => value, ttl ?? this.defaults.ttl, false)
          .then(() => {}));
  }

  // ---------------- MUTATIONS ----------------
  mutation<TArgs extends unknown[], TResult>(
    opts: MutationOptions<TArgs, TResult>
  ): MutationObject<TArgs, TResult> {
    const { key, mutationFn, onError, onMutate, onSettled, onSuccess } = opts;

    let isSuccess = false;
    let isError = false;

    const executeMutation = async (...args: TArgs): Promise<TResult> => {
      await this.ensureReady();
      this.emitEvent('MUTATION_START', [key], { args });

      let context: unknown;
      let result: TResult;
      let error: Error | null = null;

      try {
        // Call onMutate if provided
        if (onMutate) {
          context = await onMutate(args);
        }

        // Execute the mutation
        result = await mutationFn(...args);

        // Success path
        isSuccess = true;
        isError = false;

        if (onSuccess) {
          await onSuccess(result, args, context);
        }

        this.emitEvent('MUTATION_COMPLETE', [key]);

        if (onSettled) {
          await onSettled(result, null, args, context);
        }

        return result;
      } catch (error_) {
        // Error path
        isError = true;
        isSuccess = false;
        error = error_ as Error;

        if (onError) {
          await onError(error, args, context);
        }

        this.emitEvent('MUTATION_ERROR', [key], error);

        if (onSettled) {
          await onSettled(undefined, error, args, context);
        }

        throw error;
      }
    };

    return {
      get isError() {
        return isError;
      },
      get isSuccess() {
        return isSuccess;
      },
      mutate: executeMutation,
      mutateAsync: executeMutation
    };
  }

  invalidate(key: QueryKey) {
    this.emitEvent('INVALIDATE', key);
    this.enqueue(async () => {
      await this.cache.invalidate(key);
    });
  }

  invalidateQueries(prefix: QueryKey) {
    this.emitEvent('INVALIDATE_BRANCH', prefix);
    this.enqueue(async () => {
      await this.cache.invalidateQueries(prefix);
    });
  }

  async refetchQueries(
    queryKey: QueryKey | QueryKey[] | ((key: QueryKey) => boolean),
    options?: RefetchOptions
  ): Promise<RefetchResult[]> {
    await this.ensureReady();

    // Resolve matching keys via adapter or fallback for explicit list
    let matchingKeys: QueryKey[] = [];
    if (
      Array.isArray(queryKey) &&
      queryKey.length > 0 &&
      Array.isArray((queryKey as unknown[])[0])
    ) {
      // Explicit list of keys — use directly, no cache filtering needed
      matchingKeys = queryKey as QueryKey[];
    } else if (this.cache.findMatchingKeys) {
      matchingKeys = await Promise.resolve(
        this.cache.findMatchingKeys(queryKey)
      );
    } else {
      throw new Error(
        'refetchQueries requires adapter.findMatchingKeys for this matcher on the current adapter'
      );
    }

    const ttl = this.defaults.ttl;

    const doRefetch = async (key: QueryKey): Promise<RefetchResult> => {
      try {
        const norm = normalizeKey(key);
        const entry = await this.cache.getEntry(key);
        const fn =
          (entry?.queryFn as (() => AsyncOrSync<unknown>) | undefined) ??
          this.queryFnRegistry.get(norm);
        if (!fn) {
          return {
            error: new Error(
              `No query function found for key ${JSON.stringify(key)}`
            ),
            key
          };
        }
        this.emitEvent('REFETCH', key);
        const data = await fn();
        // Force update cache and TTL regardless of freshness
        if (this.cache.set) {
          await this.cache.set(key, data, ttl);
        }
        return { data, key };
      } catch (error) {
        this.emitEvent('ERROR', key, error);
        return { error: error as Error, key };
      }
    };

    if (options?.throwOnError) {
      const results: RefetchResult[] = [];
      for (const key of matchingKeys) {
        const r = await doRefetch(key);
        if (r.error) {
          throw r.error;
        }
        results.push(r);
      }
      return results;
    }

    const limit = Math.max(
      1,
      Math.min(
        matchingKeys.length,
        options?.concurrency
          ? Math.floor(options.concurrency)
          : matchingKeys.length
      )
    );
    const results: RefetchResult[] = [];
    let index = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        const i = index++;
        if (i >= matchingKeys.length) {
          break;
        }
        const key = matchingKeys[i]!;
        const r = await doRefetch(key);
        results.push(r);
      }
    });
    await Promise.all(workers);
    return results;
  }

  clear() {
    this.emitEvent('CLEAR_ALL');
    this.enqueue(async () => {
      await this.cache.clear();
    });
  }

  async clearAll(): Promise<void> {
    this.emitEvent('CLEAR_ALL');
    await this.ensureReady();
    await Promise.resolve(this.cache.clear());
  }

  on<TEvent extends EventType>(
    event: TEvent,
    handler: (data: EventMap[TEvent]) => void
  ) {
    this.emitter.on(event, handler as (data: BaseEvent) => void);
  }

  off<TEvent extends EventType>(
    event: TEvent,
    handler: (data: EventMap[TEvent]) => void
  ) {
    this.emitter.off(event, handler as (data: BaseEvent) => void);
  }

  async close(): Promise<void> {
    await this.ensureReady();
    if (this.cache.close) {
      await this.cache.close();
    }
  }

  stats() {
    // return a copy to avoid external mutation
    return { ...this._stats };
  }

  resetStats() {
    this._stats = { errors: 0, fetches: 0, hits: 0, misses: 0, stale: 0 };
  }

  async gc(): Promise<number> {
    if (this.cache.gc) {
      return await Promise.resolve(this.cache.gc());
    }
    return 0;
  }
}

// Export global instance
export const queryClient = new QueryClient({ logging: true });

// ----- Events typing -----
export type EventType =
  | 'MISS'
  | 'HIT'
  | 'STALE→SWR'
  | 'FETCH'
  | 'ERROR'
  | 'MUTATION_START'
  | 'MUTATION_COMPLETE'
  | 'MUTATION_ERROR'
  | 'INVALIDATE'
  | 'INVALIDATE_BRANCH'
  | 'CLEAR_ALL'
  | 'REFETCH'
  | 'event';

export type BaseEvent = {
  key?: QueryKey;
  meta?: unknown;
  ts: number;
  type: EventType;
};

export type EventMap = Record<EventType | 'event', BaseEvent>;

// ----- Public helper types -----
export type RefetchOptions = { concurrency?: number; throwOnError?: boolean };
export type RefetchResult = { data?: unknown; error?: Error; key: QueryKey };
