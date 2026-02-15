# ODGN query

A caching framework not unlike [Tanstack Query](https://github.com/TanStack/query)

Runtime support: Works in browsers, Node, and Deno by default via the in-memory LRU adapter. Redis and SQLite adapters are optional and loaded lazily; they require Bun at runtime. You can also plug in your own adapter to use any store (e.g., Node Redis client, Deno KV).

## Usage

### Basic Query

```typescript
import { QueryClient } from 'odgn-query';

const client = new QueryClient();

const { data, error } = await client.query({
  queryFn: () => fetch('/api/users').then(res => res.json()),
  queryKey: ['users']
});
if (error) throw error;
// use data
```

Note: `query()` returns an object `{ data, error }`. There is no global singleton — always instantiate your own `QueryClient`.

### Query with Options

```typescript
const { data, error } = await client.query({
  queryFn: async () => {
    // Simulate API call
    return { id: 1, name: 'John' };
  },
  queryKey: ['user', 1],
  ttl: 60000, // 1 minute
  backgroundRefresh: true,
  retry: 3, // retry up to 3 times on failure
  retryDelay: attempt => 1000 * 2 ** attempt // exponential backoff starting at 1s
});
if (error) throw error;
// use data
```

Retry can also be configured globally on the `QueryClient`:

```typescript
const client = new QueryClient({
  retry: 2,
  retryDelay: attempt => 500 * 2 ** attempt // 500ms, 1s, 2s, ...
});
```

### Mutations

```typescript
const updateUser = client.mutation({
  key: 'updateUser',
  mutationFn: async (userId: number, updates: any) => {
    const response = await fetch(`/api/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
    return response.json();
  },
  onSuccess: (data, variables) => {
    console.log('User updated:', data);
    // Manually invalidate related queries
    client.invalidate(['user', data.id]);
    client.invalidate(['users']);
  },
  onError: (error, variables) => {
    console.error('Update failed:', error);
  }
});

// Use the mutation - returns an object with state and methods
const { mutate, mutateAsync, isSuccess, isError } = updateUser;

// Fire-and-forget (errors handled by onError callback)
mutate(1, { name: 'Jane' });

// Or await the result and handle errors yourself
const updatedUser = await mutateAsync(1, { name: 'John' });

// Check mutation state
if (isSuccess) {
  console.log('Mutation completed successfully');
}
if (isError) {
  console.log('Mutation failed');
}
```

#### Mutation Options

- `mutationFn`: The function that performs the mutation
- `onMutate`: Called before the mutation function executes
- `onSuccess`: Called when the mutation succeeds (use this to manually invalidate queries)
- `onError`: Called when the mutation fails
- `onSettled`: Called when the mutation completes (regardless of success/error)

#### Manual Invalidation

Unlike TanStack Query, this library requires manual invalidation. Use `onSuccess` to invalidate queries:

```typescript
onSuccess: (data, variables) => {
  // Invalidate specific queries
  client.invalidate(['user', data.id]);
  client.invalidate(['users']);

  // Or invalidate by prefix
  client.invalidateQueries(['user']);
};
```

#### Mutation Return Object

The `mutation()` method returns an object with:

- `mutate`: Fire-and-forget execution (returns `void`; errors are swallowed and routed to `onError`)
- `mutateAsync`: Execute and await the result (returns `Promise<TResult>`; throws on error)
- `isSuccess`: Boolean indicating if last mutation succeeded
- `isError`: Boolean indicating if last mutation failed

### Event Listening

```typescript
client.on('event', event => {
  console.log(`Event: ${event.type}`, event.key);
});
```

### Cache Management

```typescript
// Invalidate a single query (returns a promise)
await client.invalidate(['users', 1]);

// Invalidate by prefix (returns a promise)
await client.invalidateQueries(['users']);

// Clear the entire cache (returns a promise)
await client.clear();
```

### Refetching

Refetch and refresh cached queries by key, prefix, or predicate. Refetch always executes the original query function and updates the cache value and TTL immediately.

```ts
// Exact keys
const results = await client.refetchQueries([['users'], ['user', 1]]);

// Prefix
const branch = await client.refetchQueries(['users']);

// Predicate
const subset = await client.refetchQueries(key => key[0] === 'users');

// Error mode: throw on first error
await client.refetchQueries([['user', 2]], { throwOnError: true });

// Concurrency control (defaults to all-at-once when not throwing)
await client.refetchQueries(['users'], { concurrency: 4 });
```

Returns an array of `{ key, data?, error? }`. When `throwOnError: true`, refetch short-circuits on the first error.

Notes:

- Cache is updated with the new value and TTL for each successful refetch.
- Matching support:
  - LRU adapter: exact, prefix, and predicate.
  - Redis/SQLite adapters: exact, prefix, and predicate are supported (async `findMatchingKeys`).
- For custom adapters, implement `findMatchingKeys(matcher)` returning `Promise<QueryKey[]> | QueryKey[]` to enable prefix/predicate; exact key lists work without it.
- When `throwOnError: true`, refetch runs sequentially (concurrency effectively 1) and throws on the first error.

### Direct Data Access

```ts
// Read cached data (may be stale)
const users = await client.getQueryData<User[]>(['users']);

// Seed/optimistically update cached data
await client.setQueryData(['users', 1], { id: 1, name: 'Alice' }, 60000);
```

### Stats and GC

```ts
// Reset counters
client.resetStats();

// Run some queries
await client.query({
  queryFn: () => fetch('/api').then(r => r.json()),
  queryKey: ['api']
});
await client.query({
  queryFn: () => fetch('/api').then(r => r.json()),
  queryKey: ['api']
});

// Inspect counters: { hits, misses, stale, fetches, errors }
console.log(client.stats());

// Garbage-collect expired entries (removes only expired ones)
const removed = await client.gc();
console.log(`GC removed ${removed} entries`);
```

### LRU Storage (Default)

```typescript
import { QueryClient } from 'odgn-query';

const client = new QueryClient({ cache: 'lru' });

const { data, error } = await client.query({
  queryFn: () => fetch('/api/users').then(r => r.json()),
  queryKey: ['users']
});
if (error) throw error;
```

Refetch examples (LRU):

```ts
// Prefix refetch
await client.refetchQueries(['users']);

// Predicate refetch
await client.refetchQueries(key => key[0] === 'users');
```

### Redis Storage (Local)

By default, an in-memory LRU cache is used. To use Redis (Bun-only) without breaking browser usage, the Redis code is loaded dynamically only when requested:

```typescript
import { QueryClient } from 'odgn-query';

const client = new QueryClient({
  cache: 'redis',
  redis: {
    url: 'redis://127.0.0.1:6379',
    prefix: 'odgnq' // optional namespace, default 'odgnq'
    // defaultTtl: 60000 // optional freshness window in ms
  }
});

const { data, error } = await client.query({
  queryFn: () => fetch('/api/users').then(r => r.json()),
  queryKey: ['users']
});
if (error) throw error;
```

Note: This built-in Redis adapter requires Bun at runtime (uses `Bun.Redis`). In Node/Deno, either stick with the LRU adapter or provide a custom adapter (see below) backed by your preferred Redis client.

```ts
// When finished, close the client/adapter
await client.close();
```

Refetch examples (Redis):

```ts
// Prefix refetch (async findMatchingKeys)
await client.refetchQueries(['users']);

// Predicate refetch
await client.refetchQueries(key => key[0] === 'users');
```

### SQLite Storage (File DB)

SQLite is also supported via Bun's built-in `bun:sqlite`. It's dynamically loaded only when selected:

```typescript
import { QueryClient } from 'odgn-query';

const client = new QueryClient({
  cache: 'sqlite',
  sqlite: {
    path: './odgnq-cache.sqlite', // file path
    namespace: 'odgnq' // optional, default 'odgnq'
    // defaultTtl: 60000 // optional freshness window in ms
  }
});

const { data, error } = await client.query({
  queryFn: () => fetch('/api/users').then(r => r.json()),
  queryKey: ['users']
});
if (error) throw error;
```

Note: This built-in SQLite adapter requires Bun at runtime (uses `bun:sqlite`).

```ts
// When finished, close the client/adapter
await client.close();
```

Refetch examples (SQLite):

```ts
// Prefix refetch (async findMatchingKeys)
await client.refetchQueries(['users']);

// Predicate refetch
await client.refetchQueries(key => key[0] === 'users');
```

### Custom Adapters (Node/Deno friendly)

You can supply your own cache adapter that implements the `CacheAdapter` contract, avoiding any Bun-specific APIs:

```ts
import { QueryClient, type CacheAdapter, type QueryKey } from 'odgn-query';

const myAdapter: CacheAdapter = {
  async wrap<T>(key: QueryKey, fn: () => Promise<T>, ttl = 60000) {
    // your storage logic here
    return fn();
  },
  invalidate: async key => {},
  invalidateQueries: async prefix => {},
  getEntry: async key => undefined,
  clear: async () => {},
  set: async (key, value, ttl) => {},
  // Optional but recommended to enable refetchQueries by prefix/predicate
  findMatchingKeys: async matcher => {
    // enumerate your keys and filter with matcher
    return [];
  }
};

const client = new QueryClient({ adapter: myAdapter });
```

### Subpath Exports

The Redis and SQLite adapters are also available as direct subpath imports:

```ts
import { RedisQueryCache } from 'odgn-query/redis';
import { SqliteQueryCache } from 'odgn-query/sqlite';
```

## Install

```bash
bun install
```

## API

- Types
  - `QueryKey`: readonly array of primitives, e.g. `['users', 1]`.
  - `QueryClientOptions`: constructor options including `cache`, `retry`, `retryDelay`, `defaultTtl`, etc.
  - `RefetchOptions`: `{ concurrency?: number; throwOnError?: boolean }`.
  - `RefetchResult`: `{ key: QueryKey; data?: unknown; error?: Error }`.
  - `CacheAdapter`: pluggable cache interface; `findMatchingKeys` may be async.

- Query
  - Signature: `query<T>(opts) => Promise<{ data: T | undefined; error: Error | undefined }>`
  - Per-query options: `queryKey`, `queryFn`, `ttl`, `backgroundRefresh`, `retry`, `retryDelay`.

- Mutation
  - `mutate(...args)`: fire-and-forget (returns `void`).
  - `mutateAsync(...args)`: returns `Promise<TResult>`, throws on error.

- Cache management
  - `invalidate(key)`, `invalidateQueries(prefix)`, `clear()` — all return `Promise<void>`.

- Refetch
  - Signature: `refetchQueries(matcher, options?) => Promise<RefetchResult[]>`
  - `matcher`: `QueryKey` (prefix), `QueryKey[]` (exact keys), or `(key) => boolean` predicate.
  - Behavior: executes stored queryFn for each match; writes fresh value back and refreshes TTL; emits `REFETCH`/`ERROR` events.
  - Error mode: `throwOnError` short-circuits on first error (sequential). Otherwise runs with optional `concurrency` (defaults to all-at-once).

Example with types:

```ts
import {
  QueryClient,
  type RefetchOptions,
  type RefetchResult
} from 'odgn-query';

const client = new QueryClient();
const opts: RefetchOptions = { concurrency: 4 };
const results: RefetchResult[] = await client.refetchQueries(['users'], opts);
```

## License

MIT — see [LICENSE](./LICENSE).
