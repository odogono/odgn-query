/* eslint-disable @nkzw/no-instanceof */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createSqliteQueryCache } from '../sqlite';

// Helper to wait
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// ---------------- SQLite Adapter ----------------
describe('SqliteQueryCache adapter', () => {
  let cache: Awaited<ReturnType<typeof createSqliteQueryCache>>;

  beforeEach(async () => {
    cache = await createSqliteQueryCache({ path: ':memory:' });
  });

  test('preserves exotic types when cached', async () => {
    const date = new Date('2020-01-01T00:00:00Z');
    const big = 123_456_789_012_345_678_901_234_567_890n;
    const rx = /hello/gi;
    const map = new Map<string, number>([
      ['a', 1],
      ['b', 2]
    ]);
    const set = new Set<string>(['x', 'y']);
    const undef = undefined;

    const keyDate = ['exotic', 'date'];
    const keyBig = ['exotic', 'bigint'];
    const keyRx = ['exotic', 'regexp'];
    const keyMap = ['exotic', 'map'];
    const keySet = ['exotic', 'set'];
    const keyUndef = ['exotic', 'undef'];

    // Prime cache
    await cache.wrap(keyDate, () => Promise.resolve(date));
    await cache.wrap(keyBig, () => Promise.resolve(big));
    await cache.wrap(keyRx, () => Promise.resolve(rx));
    await cache.wrap(keyMap, () => Promise.resolve(map));
    await cache.wrap(keySet, () => Promise.resolve(set));
    await cache.wrap(keyUndef, () => Promise.resolve(undef));

    // Read from cache
    const rDate = await cache.wrap(keyDate, () => Promise.resolve(new Date()));
    const rBig = await cache.wrap(keyBig, () => Promise.resolve(0n));
    const rRx = await cache.wrap(keyRx, () => Promise.resolve(/a/));
    const rMap = await cache.wrap(keyMap, () => Promise.resolve(new Map()));
    const rSet = await cache.wrap(keySet, () => Promise.resolve(new Set()));
    const rUndef = await cache.wrap(keyUndef, () =>
      Promise.resolve('not used')
    );

    expect(rDate instanceof Date).toBe(true);
    expect((rDate as Date).getTime()).toBe(date.getTime());
    expect(typeof rBig).toBe('bigint');
    expect(rBig).toBe(big);
    expect(rRx instanceof RegExp).toBe(true);
    expect((rRx as RegExp).source).toBe(rx.source);
    expect((rRx as RegExp).flags).toBe(rx.flags);
    expect(rMap instanceof Map).toBe(true);
    expect(Array.from((rMap as Map<string, number>).entries())).toEqual(
      Array.from(map.entries())
    );
    expect(rSet instanceof Set).toBe(true);
    expect(Array.from(rSet as Set<string>)).toEqual(Array.from(set));
    expect(rUndef).toBeUndefined();
  });

  test('wrap caches and returns values', async () => {
    const key = ['test'];
    const value = 'cached value';

    const result1 = await cache.wrap(key, () => Promise.resolve(value));
    expect(result1).toBe(value);

    const result2 = await cache.wrap(key, () => Promise.resolve('new value'));
    expect(result2).toBe(value);
  });

  test('wrap respects TTL with background refresh disabled', async () => {
    const key = ['ttl'];
    const result1 = await cache.wrap(
      key,
      () => Promise.resolve('first'),
      50,
      false
    );
    expect(result1).toBe('first');

    await sleep(60);

    const result2 = await cache.wrap(
      key,
      () => Promise.resolve('second'),
      50,
      false
    );
    expect(result2).toBe('second');
  });

  test('invalidate removes cached entries', async () => {
    const key = ['inv'];
    await cache.wrap(key, () => Promise.resolve('value'));

    await cache.invalidate(key);

    const result = await cache.wrap(key, () => Promise.resolve('new value'));
    expect(result).toBe('new value');
  });

  test('invalidateQueries removes entries by prefix', async () => {
    await cache.wrap(['users', 1], () => Promise.resolve('user1'));
    await cache.wrap(['users', 2], () => Promise.resolve('user2'));
    await cache.wrap(['posts', 1], () => Promise.resolve('post1'));

    await cache.invalidateQueries(['users']);

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
    expect(post1).toBe('post1');
  });

  test('clear removes all entries', async () => {
    await cache.wrap(['a'], () => Promise.resolve('1'));
    await cache.wrap(['b'], () => Promise.resolve('2'));

    await cache.clear();

    const a = await cache.wrap(['a'], () => Promise.resolve('3'));
    const b = await cache.wrap(['b'], () => Promise.resolve('4'));

    expect(a).toBe('3');
    expect(b).toBe('4');
  });

  test('background refresh works', async () => {
    const key = ['bg'];
    let count = 0;
    const fn = () => {
      count++;
      return Promise.resolve(`v${count}`);
    };

    const r1 = await cache.wrap(key, fn, 50, true);
    expect(r1).toBe('v1');
    expect(count).toBe(1);

    await sleep(60);

    const r2 = await cache.wrap(key, fn, 50, true);
    expect(r2).toBe('v1');

    await sleep(20);

    const r3 = await cache.wrap(key, fn, 50, true);
    expect(r3).toBe('v2');
    expect(count).toBe(2);
  });
});
