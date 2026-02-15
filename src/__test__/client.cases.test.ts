import { beforeEach, describe, expect, test } from 'bun:test';

import { QueryClient } from '../client';

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

describe('QueryClient Cases', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ logging: false });
  });

  test('case 1', async () => {
    let userName = 'John';

    const queryFn = () => Promise.resolve({ id: 1, name: userName });

    const result = await client.query({
      queryFn,
      queryKey: ['test', 'users'],
      ttl: 1000
    });

    expect(result.data).toEqual({ id: 1, name: 'John' });

    userName = 'Jane';
    const result2 = await client.query({
      queryFn,
      queryKey: ['test', 'users'],
      ttl: 1000
    });

    expect(result2.data).toEqual({ id: 1, name: 'John' });

    await client.invalidateQueries(['test']);

    const result3 = await client.query({
      queryFn,
      queryKey: ['test', 'users'],
      ttl: 1000
    });

    expect(result3.data).toEqual({ id: 1, name: 'Jane' });
  });
});
