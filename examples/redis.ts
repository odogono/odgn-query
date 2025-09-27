/* eslint-disable @nkzw/no-instanceof */
/* eslint-disable no-console */
// Run with: bun run examples/redis.ts
// Requires a local Redis server at redis://127.0.0.1:6379
import { QueryClient } from '../src/client';

const client = new QueryClient({
  cache: 'redis',
  logging: true,
  redis: {
    prefix: 'odgnq_examples',
    url: 'redis://127.0.0.1:6379'
  }
});

const key = ['examples', 'redis'];

const exotic = () => ({
  big: 987_654_321_987_654_321n,
  map: new Map<string, string>([
    ['x', '1'],
    ['y', '2']
  ]),
  now: new Date('2021-02-03T04:05:06Z'),
  rx: /world/m,
  set: new Set<number>([1, 2, 3]),
  undef: undefined as undefined | string
});

const main = async () => {
  console.log('Redis example: first call (miss + store)');
  const r1 = await client.query({
    queryFn: exotic,
    queryKey: key,
    ttl: 30_000
  });
  if (r1.error) {
    throw r1.error;
  }
  console.log('Types:', {
    bigint: typeof r1.data?.big === 'bigint',
    date: r1.data?.now instanceof Date,
    map: r1.data?.map instanceof Map,
    regexp: r1.data?.rx instanceof RegExp,
    set: r1.data?.set instanceof Set,
    undef: r1.data?.undef === undefined
  });

  console.log('Redis example: second call (cached)');
  const r2 = await client.query({
    queryFn: exotic,
    queryKey: key,
    ttl: 30_000
  });
  if (r2.error) {
    throw r2.error;
  }
  console.log('Cached ok');
};

await main();
