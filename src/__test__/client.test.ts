import { beforeEach, describe, expect, test } from 'bun:test';

import { QueryClient, type EventData } from '../client';

describe('QueryClient', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ logging: false });
  });

  test('query caches results', async () => {
    let callCount = 0;
    const queryFn = () => {
      callCount++;
      return Promise.resolve(`result${callCount}`);
    };

    const result1 = await client.query({
      queryFn,
      queryKey: ['test']
    });
    expect(result1.data).toBe('result1');

    const result2 = await client.query({
      queryFn,
      queryKey: ['test']
    });
    expect(result2.data).toBe('result1'); // cached
    expect(callCount).toBe(1);
  });

  test('query respects custom TTL with background refresh disabled', async () => {
    const client = new QueryClient({ logging: false });
    let callCount = 0;

    const result1 = await client.query({
      backgroundRefresh: false,
      queryFn: () => {
        callCount++;
        return Promise.resolve(`result${callCount}`);
      },
      queryKey: ['test'],
      ttl: 50
    });
    expect(result1.data).toBe('result1');

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 60));

    const result2 = await client.query({
      backgroundRefresh: false,
      queryFn: () => {
        callCount++;
        return Promise.resolve(`result${callCount}`);
      },
      queryKey: ['test'],
      ttl: 50
    });
    expect(result2.data).toBe('result2');
  });

  test('invalidate removes specific query', async () => {
    await client.query({
      queryFn: () => Promise.resolve('value1'),
      queryKey: ['test1']
    });
    await client.query({
      queryFn: () => Promise.resolve('value2'),
      queryKey: ['test2']
    });

    client.invalidate(['test1']);

    let callCount1 = 0;
    let callCount2 = 0;

    const result1 = await client.query({
      queryFn: () => {
        callCount1++;
        return Promise.resolve('new value1');
      },
      queryKey: ['test1']
    });
    const result2 = await client.query({
      queryFn: () => {
        callCount2++;
        return Promise.resolve('new value2');
      },
      queryKey: ['test2']
    });

    expect(result1.data).toBe('new value1');
    expect(result2.data).toBe('value2'); // still cached
    expect(callCount1).toBe(1);
    expect(callCount2).toBe(0);
  });

  test('invalidateQueries removes queries by prefix', async () => {
    await client.query({
      queryFn: () => Promise.resolve('user1'),
      queryKey: ['users', 1]
    });
    await client.query({
      queryFn: () => Promise.resolve('user2'),
      queryKey: ['users', 2]
    });
    await client.query({
      queryFn: () => Promise.resolve('post1'),
      queryKey: ['posts', 1]
    });

    client.invalidateQueries(['users']);

    let userCallCount = 0;
    let postCallCount = 0;

    await client.query({
      queryFn: () => {
        userCallCount++;
        return Promise.resolve('new user1');
      },
      queryKey: ['users', 1]
    });
    await client.query({
      queryFn: () => {
        postCallCount++;
        return Promise.resolve('new post1');
      },
      queryKey: ['posts', 1]
    });

    expect(userCallCount).toBe(1);
    expect(postCallCount).toBe(0); // posts still cached
  });

  test('clear removes all cached queries', async () => {
    await client.query({
      queryFn: () => Promise.resolve('value1'),
      queryKey: ['test1']
    });
    await client.query({
      queryFn: () => Promise.resolve('value2'),
      queryKey: ['test2']
    });

    client.clear();

    let callCount1 = 0;
    let callCount2 = 0;

    await client.query({
      queryFn: () => {
        callCount1++;
        return Promise.resolve('new value1');
      },
      queryKey: ['test1']
    });
    await client.query({
      queryFn: () => {
        callCount2++;
        return Promise.resolve('new value2');
      },
      queryKey: ['test2']
    });

    expect(callCount1).toBe(1);
    expect(callCount2).toBe(1);
  });

  test('clearAll removes all cached queries and awaits completion', async () => {
    await client.query({
      queryFn: () => Promise.resolve('value1'),
      queryKey: ['test1']
    });
    await client.query({
      queryFn: () => Promise.resolve('value2'),
      queryKey: ['test2']
    });

    await client.clearAll();

    let callCount1 = 0;
    let callCount2 = 0;

    await client.query({
      queryFn: () => {
        callCount1++;
        return Promise.resolve('new value1');
      },
      queryKey: ['test1']
    });
    await client.query({
      queryFn: () => {
        callCount2++;
        return Promise.resolve('new value2');
      },
      queryKey: ['test2']
    });

    expect(callCount1).toBe(1);
    expect(callCount2).toBe(1);
  });

  test('events are emitted', async () => {
    const events: EventData[] = [];
    client.on('event', event => events.push(event as EventData));

    await client.query({
      queryFn: () => Promise.resolve('value'),
      queryKey: ['test']
    });

    expect(events.some(e => e.type === 'MISS')).toBe(true);
    expect(events.some(e => e.type === 'FETCH')).toBe(true);
  });

  test('query returns error on failure', async () => {
    const res = await client.query({
      queryFn: () => {
        throw new Error('boom');
      },
      queryKey: ['error']
    });
    expect(res.data).toBeUndefined();
    expect(res.error).toBeInstanceOf(Error);
    expect(res.error?.message).toBe('boom');
  });

  test('close resolves with default LRU adapter', async () => {
    const client = new QueryClient({ logging: false });
    await client.close();
  });

  test('close delegates to provided adapter.close', async () => {
    let closed = 0;
    const adapter = {
      async clear() {},
      async close() {
        closed++;
      },
      async getEntry() {
        return undefined;
      },
      async invalidate() {},
      async invalidateQueries() {},
      async wrap() {
        return undefined as unknown as string;
      }
    };
    // @ts-expect-error minimal adapter for test
    const client = new QueryClient({ adapter, logging: false });
    await client.close();
    expect(closed).toBe(1);
  });

  test('close waits for async adapterFactory and then closes', async () => {
    let closed = 0;
    const adapter = {
      async clear() {},
      async close() {
        closed++;
      },
      async getEntry() {
        return undefined;
      },
      async invalidate() {},
      async invalidateQueries() {},
      async wrap() {
        return undefined as unknown as string;
      }
    };
    const client = new QueryClient({
      adapterFactory: async () => {
        await new Promise(res => setTimeout(res, 10));
        // @ts-expect-error minimal adapter for test
        return adapter;
      },
      logging: false
    });
    await client.close();
    expect(closed).toBe(1);
  });

  test('stats counters track hits/misses/stale/fetch/errors', async () => {
    const client = new QueryClient({ defaultTtl: 50, logging: false });
    client.resetStats();

    // First miss + fetch
    await client.query({
      queryFn: () => Promise.resolve('v1'),
      queryKey: ['k']
    });

    // Hit
    await client.query({
      queryFn: () => Promise.resolve('unused'),
      queryKey: ['k']
    });

    // Let it go stale
    await new Promise(res => setTimeout(res, 60));

    // Stale + background refresh + returns stale value
    await client.query({
      queryFn: () => Promise.resolve('v2'),
      queryKey: ['k']
    });

    const s = client.stats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.stale).toBe(1);
    // 2 fetches: initial + refresh
    expect(s.fetches).toBe(2);
    expect(s.errors).toBe(0);
  });

  test('gc removes expired entries (LRU adapter)', async () => {
    const client = new QueryClient({ logging: false });
    await client.setQueryData(['gc', 1], 'a', 30);
    await client.setQueryData(['gc', 2], 'b', 1000);
    // ensure set
    expect(await client.getQueryData(['gc', 1])).toBe('a');
    expect(await client.getQueryData(['gc', 2])).toBe('b');

    // wait for first to expire
    await new Promise(res => setTimeout(res, 40));
    const removed = await client.gc();
    expect(removed).toBe(1);

    // key 1 should be gone
    const res1 = await client.query({
      backgroundRefresh: false,
      queryFn: () => Promise.resolve('refetch-a'),
      queryKey: ['gc', 1]
    });
    expect(res1.data).toBe('refetch-a');
  });
});
