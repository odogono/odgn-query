/* eslint-disable no-console */
/* eslint-disable @nkzw/no-instanceof */
// Run with: bun run examples/sqlite.ts
// Creates/uses a file DB at examples/odgnq-example.sqlite
import { QueryClient, type RefetchResult } from '@/client';

const client = new QueryClient({
  cache: 'sqlite',
  logging: true,
  sqlite: {
    namespace: 'odgnq_examples',
    path: 'examples/odgnq-example.sqlite'
  }
});

const key = ['examples', 'sqlite'];

const exotic = () => ({
  big: 11_112_222_333_344_445_555n,
  map: new Map<number, string>([
    [1, 'a'],
    [2, 'b']
  ]),
  now: new Date('2022-03-04T05:06:07Z'),
  rx: /abc/i,
  set: new Set<boolean>([true, false]),
  undef: undefined as undefined | string
});

const main = async () => {
  console.log('SQLite example: first call (miss + store)');
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

  console.log('SQLite example: second call (cached)');
  const r2 = await client.query({
    queryFn: exotic,
    queryKey: key,
    ttl: 30_000
  });
  if (r2.error) {
    throw r2.error;
  }
  console.log('Cached ok');

  // Demonstrate refetchQueries on a branch
  await client.query({
    queryFn: () => Promise.resolve('u1'),
    queryKey: ['users', 1]
  });
  await client.query({
    queryFn: () => Promise.resolve('u2'),
    queryKey: ['users', 2]
  });
  const refetched: RefetchResult[] = await client.refetchQueries(['users'], {
    concurrency: 2
  });
  console.log(
    'Refetched (sqlite):',
    refetched.map(r => ({ key: r.key, ok: !r.error }))
  );
};

await main();
