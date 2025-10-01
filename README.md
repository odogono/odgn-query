# ODGN query

A minimal, barely passable, implemention of a caching framework not unlike [Tanstack Query](https://github.com/TanStack/query)

Runtime support: Works in browsers, Node, and Deno by default via the in-memory LRU adapter. Redis and SQLite adapters are optional and loaded lazily; they require Bun at runtime. You can also plug in your own adapter to use any store (e.g., Node Redis client, Deno KV).

## Usage

### Basic Query

```typescript
import { queryClient } from 'odgn-query';

const { data, error } = await queryClient.query({
  queryFn: () => fetch('/api/users').then(res => res.json()),
  queryKey: ['users']
});
if (error) throw error;
// use data
```

Note: `query()` returns an object `{ data, error }`.

### Query with Options

```typescript
const { data, error } = await queryClient.query({
  queryFn: async () => {
    // Simulate API call
    return { id: 1, name: 'John' };
  },
  queryKey: ['user', 1],
  ttl: 60000, // 1 minute
  backgroundRefresh: true
});
if (error) throw error;
// use data
```

### Mutations

```typescript
const updateUser = queryClient.mutation({
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
    queryClient.invalidate(['user', userId]);
    queryClient.invalidate(['users']);
  },
  onError: (error, variables) => {
    console.error('Update failed:', error);
  }
});

// Use the mutation - returns an object with state and methods
const { mutate, mutateAsync, isSuccess, isError } = updateUser;

// Execute the mutation
const updatedUser = await mutate(1, { name: 'Jane' });
// or
const updatedUser2 = await mutateAsync(1, { name: 'John' });

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
  queryClient.invalidate(['user', data.id]);
  queryClient.invalidate(['users']);

  // Or invalidate by prefix
  queryClient.invalidateQueries(['user']);
};
```

#### Mutation Return Object

The `mutation()` method returns an object with:

- `mutate`: Execute the mutation (returns Promise<TResult>)
- `mutateAsync`: Alias for `mutate`
- `isSuccess`: Boolean indicating if last mutation succeeded
- `isError`: Boolean indicating if last mutation failed

### Event Listening

```typescript
queryClient.on('event', event => {
  console.log(`Event: ${event.type}`, event.key);
});
```

### Cache Management

```typescript
// Invalidate a single query
queryClient.invalidate(['users', 1]);

// Invalidate by prefix (branch)
queryClient.invalidateQueries(['users']);

// Clear the entire cache (fire-and-forget)
queryClient.clear();

// Clear the entire cache and await completion
await queryClient.clearAll();
```

### Refetching

Refetch and refresh cached queries by key, prefix, or predicate. Refetch always executes the original query function and updates the cache value and TTL immediately.

```ts
// Exact keys
const results = await queryClient.refetchQueries([['users'], ['user', 1]]);

// Prefix
const branch = await queryClient.refetchQueries(['users']);

// Predicate
const subset = await queryClient.refetchQueries(key => key[0] === 'users');

// Error mode: throw on first error
await queryClient.refetchQueries([['user', 2]], { throwOnError: true });

// Concurrency control (defaults to all-at-once when not throwing)
await queryClient.refetchQueries(['users'], { concurrency: 4 });
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
const users = await queryClient.getQueryData<User[]>(['users']);

// Seed/optimistically update cached data
await queryClient.setQueryData(['users', 1], { id: 1, name: 'Alice' }, 60000);
```

### Stats and GC

```ts
// Reset counters
queryClient.resetStats();

// Run some queries
await queryClient.query({
  queryFn: () => fetch('/api').then(r => r.json()),
  queryKey: ['api']
});
await queryClient.query({
  queryFn: () => fetch('/api').then(r => r.json()),
  queryKey: ['api']
});

// Inspect counters: { hits, misses, stale, fetches, errors }
console.log(queryClient.stats());

// Garbage-collect expired entries (removes only expired ones)
const removed = await queryClient.gc();
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

To install dependencies:

````bash
bun install

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
````

````

To run:

```bash
bun run index.ts
````

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## API

- Types
  - `QueryKey`: readonly array of primitives, e.g. `['users', 1]`.
  - `RefetchOptions`: `{ concurrency?: number; throwOnError?: boolean }`.
  - `RefetchResult`: `{ key: QueryKey; data?: unknown; error?: Error }`.
  - `CacheAdapter`: pluggable cache interface; `findMatchingKeys` may be async.

- Refetch
  - Signature: `refetchQueries(matcher, options?) => Promise<RefetchResult[]>`
  - `matcher`: `QueryKey` (prefix), `QueryKey[]` (exact keys), or `(key) => boolean` predicate.
  - Behavior: executes stored queryFn for each match; writes fresh value back and refreshes TTL; emits `REFETCH`/`ERROR` events.
  - Error mode: `throwOnError` short-circuits on first error (sequential). Otherwise runs with optional `concurrency` (defaults to all-at-once).

Example with types:

```ts
import {
  queryClient,
  type RefetchOptions,
  type RefetchResult
} from 'odgn-query';

const opts: RefetchOptions = { concurrency: 4 };
const results: RefetchResult[] = await queryClient.refetchQueries(
  ['users'],
  opts
);
```

## License

MIT — see [LICENSE](./LICENSE).
