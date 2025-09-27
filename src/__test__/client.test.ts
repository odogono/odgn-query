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

  test('mutation executes and invalidates', async () => {
    // Set up initial query
    await client.query({
      queryFn: () => Promise.resolve('user1'),
      queryKey: ['users', 1]
    });

    // Create mutation that invalidates the query
    const updateUser = client.mutation({
      invalidate: result => [['users', result.id]],
      key: 'updateUser',
      mutationFn: (id: number, name: string) => Promise.resolve({ id, name })
    });

    // Execute mutation
    const result = await updateUser(1, 'updated');
    expect(result).toEqual({ id: 1, name: 'updated' });

    // Query should be invalidated and refetch
    let callCount = 0;
    const newResult = await client.query({
      queryFn: () => {
        callCount++;
        return Promise.resolve('refetched user1');
      },
      queryKey: ['users', 1]
    });
    expect(newResult.data).toBe('refetched user1');
    expect(callCount).toBe(1);
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
});
