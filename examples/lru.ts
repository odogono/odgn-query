/* eslint-disable @nkzw/no-instanceof */
/* eslint-disable no-console */
// Run with: bun run examples/lru.ts
import { QueryClient, type RefetchResult } from '@/client';

const client = new QueryClient({ cache: 'lru', logging: true });

const key = ['examples', 'lru'];

const exotic = () => ({
  big: 1_234_567_890_123_456_789n,
  map: new Map<string, number>([
    ['a', 1],
    ['b', 2]
  ]),
  now: new Date('2020-01-01T00:00:00Z'),
  rx: /hello/gi,
  set: new Set<string>(['x', 'y']),
  undef: undefined as undefined | string
});

const main = async () => {
  console.log('LRU example: first call (miss + store)');
  const r1 = await client.query({
    queryFn: exotic,
    queryKey: key,
    ttl: 10_000
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

  console.log('LRU example: second call (cached)');
  const r2 = await client.query({
    queryFn: exotic,
    queryKey: key,
    ttl: 10_000
  });
  if (r2.error) {
    throw r2.error;
  }
  console.log('Cached ok');

  // Demonstrate refetchQueries with multiple keys and concurrency
  await client.query({
    queryFn: () => Promise.resolve('u1'),
    queryKey: ['users', 1]
  });
  await client.query({
    queryFn: () => Promise.resolve('u2'),
    queryKey: ['users', 2]
  });
  await client.query({
    queryFn: () => Promise.resolve('p1'),
    queryKey: ['posts', 1]
  });

  console.log('Refetch users branch with concurrency 2');
  const refetched: RefetchResult[] = await client.refetchQueries(['users'], {
    concurrency: 2
  });
  console.log(
    'Refetched results:',
    refetched.map(r => ({ key: r.key, ok: !r.error }))
  );
};

await main();
