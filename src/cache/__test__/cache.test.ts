import { beforeEach, describe, expect, test } from 'bun:test';

import { QueryCache, normalizeKey } from '../index';

describe('QueryCache', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache({ defaultTtl: 1000, maxSize: 10 });
  });

  test('normalizeKey converts query keys to strings', () => {
    expect(normalizeKey(['users', 1])).toBe('["users",1]');
    expect(normalizeKey(['posts', 'active'])).toBe('["posts","active"]');
  });

  test('wrap caches and returns values', async () => {
    const key = ['test'];
    const value = 'cached value';

    const result1 = await cache.wrap(key, () => Promise.resolve(value));
    expect(result1).toBe(value);

    // Second call should return cached value
    const result2 = await cache.wrap(key, () => Promise.resolve('new value'));
    expect(result2).toBe(value);
  });

  test('wrap respects TTL with background refresh disabled', async () => {
    const key = ['test'];
    const cache = new QueryCache({ defaultTtl: 1000, maxSize: 10 });

    const result1 = await cache.wrap(
      key,
      () => Promise.resolve('first'),
      50,
      false
    );
    expect(result1).toBe('first');

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 60));

    const result2 = await cache.wrap(
      key,
      () => Promise.resolve('second'),
      50,
      false
    );
    expect(result2).toBe('second');
  });

  test('invalidate removes cached entries', async () => {
    const key = ['test'];
    await cache.wrap(key, () => Promise.resolve('value'));

    cache.invalidate(key);

    const result = await cache.wrap(key, () => Promise.resolve('new value'));
    expect(result).toBe('new value');
  });

  test('invalidateQueries removes entries by prefix', async () => {
    await cache.wrap(['users', 1], () => Promise.resolve('user1'));
    await cache.wrap(['users', 2], () => Promise.resolve('user2'));
    await cache.wrap(['posts', 1], () => Promise.resolve('post1'));

    cache.invalidateQueries(['users']);

    const user1 = await cache.wrap(['users', 1], () =>
      Promise.resolve('new user1')
    );
    const user2 = await cache.wrap(['users', 2], () =>
      Promise.resolve('new user2')
    );
    const post1 = await cache.wrap(['posts', 1], () =>
      Promise.resolve('new post1')
    );

    expect(user1).toBe('new user1');
    expect(user2).toBe('new user2');
    expect(post1).toBe('post1'); // should still be cached
  });

  test('clear removes all entries', async () => {
    await cache.wrap(['test1'], () => Promise.resolve('value1'));
    await cache.wrap(['test2'], () => Promise.resolve('value2'));

    cache.clear();

    const result1 = await cache.wrap(['test1'], () => Promise.resolve('new1'));
    const result2 = await cache.wrap(['test2'], () => Promise.resolve('new2'));

    expect(result1).toBe('new1');
    expect(result2).toBe('new2');
  });

  test('background refresh works', async () => {
    const key = ['test'];
    const cache = new QueryCache({ defaultTtl: 50, maxSize: 10 });

    let callCount = 0;
    const queryFn = () => {
      callCount++;
      return Promise.resolve(`value${callCount}`);
    };

    // First call
    const result1 = await cache.wrap(key, queryFn, 50, true);
    expect(result1).toBe('value1');
    expect(callCount).toBe(1);

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 60));

    // Second call should return stale value and trigger background refresh
    const result2 = await cache.wrap(key, queryFn, 50, true);
    expect(result2).toBe('value1'); // stale value

    // Wait for background refresh to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Third call should get refreshed value
    const result3 = await cache.wrap(key, queryFn, 50, true);
    expect(result3).toBe('value2');
    expect(callCount).toBe(2);
  });

  test('coalesces concurrent misses', async () => {
    const key = ['concurrent'];
    const cache = new QueryCache({ defaultTtl: 1000, maxSize: 10 });
    let calls = 0;
    let resolveFn: (v: string) => void = () => {};
    const p = new Promise<string>(res => {
      resolveFn = res;
    });
    const fn = () => {
      calls++;
      return p;
    };

    const pr1 = cache.wrap(key, fn);
    const pr2 = cache.wrap(key, fn);
    // resolve underlying once for both callers
    resolveFn('done');
    const [r1, r2] = await Promise.all([pr1, pr2]);
    expect(r1).toBe('done');
    expect(r2).toBe('done');
    expect(calls).toBe(1);
  });
});
