/* eslint-disable @nkzw/no-instanceof */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createRedisQueryCache } from '../redis';

// Helper to wait
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Redis stub for tests (no real server needed)
class FakeRedis {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  constructor(_opts?: unknown) {}

  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  async expire(_key: string, _seconds: number) {
    return 1;
  }
  async del(...keys: string[]) {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) {
        count++;
      }
      // also allow removing sets when passed
      if (this.sets.delete(k)) {
        count++;
      }
    }
    return count;
  }
  async sadd(key: string, member: string) {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    s.add(member);
    return 1;
  }
  async smembers(key: string) {
    const s = this.sets.get(key);
    return s ? Array.from(s) : [];
  }
  async srem(key: string, member: string) {
    const s = this.sets.get(key);
    if (!s) {
      return 0;
    }
    const had = s.delete(member);
    return had ? 1 : 0;
  }
}

describe('RedisQueryCache adapter (stubbed)', () => {
  let cache: Awaited<ReturnType<typeof createRedisQueryCache>>;

  beforeEach(async () => {
    // Monkey-patch Bun.Redis to our fake
    (Bun as unknown as { Redis: typeof FakeRedis }).Redis = FakeRedis;
    cache = await createRedisQueryCache({ prefix: 'testq' });
  });

  test('preserves exotic types when cached', async () => {
    const date = new Date('2020-01-01T00:00:00Z');
    const big = 987_654_321_987_654_321n;
    const rx = /world/m;
    const map = new Map<string, string>([
      ['a', '1'],
      ['b', '2']
    ]);
    const set = new Set<number>([1, 2, 3]);

    const keyDate = ['exotic', 'date'];
    const keyBig = ['exotic', 'bigint'];
    const keyRx = ['exotic', 'regexp'];
    const keyMap = ['exotic', 'map'];
    const keySet = ['exotic', 'set'];

    await cache.wrap(keyDate, () => Promise.resolve(date));
    await cache.wrap(keyBig, () => Promise.resolve(big));
    await cache.wrap(keyRx, () => Promise.resolve(rx));
    await cache.wrap(keyMap, () => Promise.resolve(map));
    await cache.wrap(keySet, () => Promise.resolve(set));

    const rDate = await cache.wrap(keyDate, () => Promise.resolve(new Date()));
    const rBig = await cache.wrap(keyBig, () => Promise.resolve(0n));
    const rRx = await cache.wrap(keyRx, () => Promise.resolve(/x/));
    const rMap = await cache.wrap(keyMap, () => Promise.resolve(new Map()));
    const rSet = await cache.wrap(keySet, () => Promise.resolve(new Set()));

    expect(rDate instanceof Date).toBe(true);
    expect((rDate as Date).getTime()).toBe(date.getTime());
    expect(typeof rBig).toBe('bigint');
    expect(rBig).toBe(big);
    expect(rRx instanceof RegExp).toBe(true);
    expect((rRx as RegExp).source).toBe(rx.source);
    expect((rRx as RegExp).flags).toBe(rx.flags);
    expect(rMap instanceof Map).toBe(true);
    expect(Array.from((rMap as Map<string, string>).entries())).toEqual(
      Array.from(map.entries())
    );
    expect(rSet instanceof Set).toBe(true);
    expect(Array.from(rSet as Set<number>)).toEqual(Array.from(set));
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
