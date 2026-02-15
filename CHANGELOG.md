# Changelog

All notable changes to this project will be documented in this file.

## 0.3.0 - 2026-02-10

Fixed

- LRU cache no longer stores errors as values on miss path, preventing cache poisoning for the TTL duration.
- `mutate` is now fire-and-forget (does not throw); `mutateAsync` returns a promise and throws on error.
- `invalidate`/`invalidateQueries`/`clear` now return promises so callers can detect errors.
- SQLite LIKE queries escape `%`, `_`, and `\` wildcards in keys to prevent incorrect prefix matches.

Added

- Opt-in retry with exponential backoff: `retry` and `retryDelay` options on QueryClient and per-query.
- Subpath exports `odgn-query/redis` and `odgn-query/sqlite` for direct adapter imports.
- Inflight miss deduplication for Redis and SQLite adapters (matching LRU behavior).
- Redis TTL safety net: `EXPIRE` set alongside embedded expiry to prevent unbounded growth on crash.

Changed

- Removed global singleton export; consumers must instantiate `QueryClient` explicitly.
- Unified `AsyncOrSync<T>` to single definition in `src/cache/index.ts`.
- Extracted shared `isKeyPrefixMatch` utility; removed duplicates from adapters.
- Merged `clear()`/`clearAll()` into single awaitable `clear()`.
- Removed dead `isKeyExactMatch` method and stale comments.
- Pinned `@types/bun` to `^1.3.8` instead of `"latest"`.

## 0.2.1 - 2025-10-08

Added

- export QueryResult type

## 0.2.0 - 2025-10-01

Added

- refetchQueries now re-executes the stored query function and updates the cache value and TTL for each key.
- Async findMatchingKeys support: CacheAdapter.findMatchingKeys may return Promise<QueryKey[]>.
- Redis and SQLite adapters implement async findMatchingKeys, enabling prefix and predicate matching.
- Query function registry in QueryClient to support refetch across adapters that don’t persist queryFn.
- Test: verifies cache is updated after refetch.
- Refetch concurrency option: `refetchQueries(..., { concurrency })` to limit parallelism.

Changed

- refetchQueries parallelizes when not using throwOnError; sequential with early throw when throwOnError is true.
- In-memory LRU set() preserves existing queryFn, ensuring refetch remains available after manual set.

Docs

- README: added Refetching section; documented async findMatchingKeys for custom adapters and behavior guarantees.

Breaking (pre-1.0)

- Adapter authors: if you implement findMatchingKeys, update it to handle async (return Promise or value). Existing code that assumes synchronous findMatchingKeys continues to work.

## 0.1.0 - 2025-09-30

Added

- CacheAdapter contract exported from `src/cache` and re-exported from root.
- QueryClient options: `adapter`, `adapterFactory`, `defaultTtl`, `defaultBackgroundRefresh`.
- QueryClient methods: `getQueryData`, `setQueryData`, `close`, `stats`, `resetStats`, `gc`.
- LRU adapter (QueryCache): in-flight miss deduplication; `set`, `gc`, `close` (no-op).
- Redis adapter: `set`, `gc`, `close`; resolves `Bun.Redis` at runtime to avoid build-time Bun dependency.
- SQLite adapter: `set`, `gc`, `close`.
- Typed events: specific channels (`'HIT'`, `'MISS'`, `'FETCH'`, etc.) and aggregated `'event'` channel.
- Tests for close delegation, stats counters, GC, and concurrent miss dedupe.

Changed

- QueryClient queueing for `invalidate`, `invalidateQueries`, `clear` now uses thunk-based enqueue to avoid premature execution and deadlocks.
- Default ttl/backgroundRefresh are taken from client-level defaults if not specified per query.

Docs

- README updates: cross-runtime usage clarity; custom adapter example; `getQueryData`/`setQueryData`; `close`; stats and gc usage examples.

Notes

- Core remains Node/Deno/browser friendly by default (LRU). Redis/SQLite adapters are optional and require Bun at runtime only when selected.
