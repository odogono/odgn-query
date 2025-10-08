# Changelog

All notable changes to this project will be documented in this file.

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
