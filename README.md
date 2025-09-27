# ODGN query

A minimal, barely passable, implemention of a caching framework not unlike [Tanstack Query](https://github.com/TanStack/query)

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
  invalidate: (result, [userId]) => [['user', userId], ['users']]
});

// Use the mutation
const updatedUser = await updateUser(1, { name: 'Jane' });
```

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

Note: Redis support requires running under Bun (uses `Bun.Redis`). In browsers or non-Redis environments, keep the default LRU cache.

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

Note: SQLite support requires running under Bun (uses `bun:sqlite`).
To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## License

MIT — see [LICENSE](./LICENSE).
