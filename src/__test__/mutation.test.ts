import { beforeEach, describe, expect, test } from 'bun:test';

import { QueryClient } from '../client';

describe('Mutations', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ logging: false });
  });

  test('mutation executes successfully', async () => {
    const updateUser = client.mutation({
      key: 'updateUser',
      mutationFn: (id: number, name: string) => Promise.resolve({ id, name })
    });

    const result = await updateUser.mutate(1, 'updated');
    expect(result).toEqual({ id: 1, name: 'updated' });
  });

  test('mutation returns object with state flags', async () => {
    const mutation = client.mutation({
      key: 'testMutation',
      mutationFn: (value: string) => Promise.resolve(value.toUpperCase())
    });

    expect(mutation.isSuccess).toBe(false);
    expect(mutation.isError).toBe(false);

    await mutation.mutate('hello');

    expect(mutation.isSuccess).toBe(true);
    expect(mutation.isError).toBe(false);
  });

  test('mutation handles errors and updates state', async () => {
    const mutation = client.mutation({
      key: 'testError',
      mutationFn: () => Promise.reject(new Error('Test error'))
    });

    expect(mutation.isSuccess).toBe(false);
    expect(mutation.isError).toBe(false);

    try {
      await mutation.mutate();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Test error');
    }

    expect(mutation.isSuccess).toBe(false);
    expect(mutation.isError).toBe(true);
  });

  test('mutation calls lifecycle callbacks', async () => {
    const events: string[] = [];
    let context: unknown;

    const mutation = client.mutation({
      key: 'testCallbacks',
      mutationFn: (value: number) => Promise.resolve(value * 2),
      onMutate: async args => {
        events.push('onMutate');
        context = { initialValue: args[0] };
        return context;
      },
      onSettled: async (data, error, args, ctx) => {
        events.push('onSettled');
        expect(data).toBe(20);
        expect(error).toBeNull();
        expect(args).toEqual([10]);
        expect(ctx).toEqual({ initialValue: 10 });
      },
      onSuccess: async (data, args, ctx) => {
        events.push('onSuccess');
        expect(data).toBe(20);
        expect(args).toEqual([10]);
        expect(ctx).toEqual({ initialValue: 10 });
      }
    });

    const result = await mutation.mutate(10);
    expect(result).toBe(20);
    expect(events).toEqual(['onMutate', 'onSuccess', 'onSettled']);
  });

  test('mutation calls error callbacks', async () => {
    const events: string[] = [];
    let context: unknown;

    const mutation = client.mutation({
      key: 'testErrorCallbacks',
      mutationFn: () => Promise.reject(new Error('Mutation failed')),
      onError: async (error, _args, ctx) => {
        events.push('onError');
        expect(error.message).toBe('Mutation failed');
        expect(ctx).toEqual({ rollback: true });
      },
      onMutate: async () => {
        events.push('onMutate');
        context = { rollback: true };
        return context;
      },
      onSettled: async (data, error, _args, ctx) => {
        events.push('onSettled');
        expect(data).toBeUndefined();
        expect(error).toBeInstanceOf(Error);
        expect(ctx).toEqual({ rollback: true });
      }
    });

    try {
      await mutation.mutate();
    } catch (error) {
      expect((error as Error).message).toBe('Mutation failed');
    }

    expect(events).toEqual(['onMutate', 'onError', 'onSettled']);
  });

  test('mutate and mutateAsync are equivalent', async () => {
    const mutation = client.mutation({
      key: 'testEquivalence',
      mutationFn: (value: string) => Promise.resolve(value.toUpperCase())
    });

    const result1 = await mutation.mutate('hello');
    const result2 = await mutation.mutateAsync('world');

    expect(result1).toBe('HELLO');
    expect(result2).toBe('WORLD');
  });

  test('manual invalidation in onSuccess callback', async () => {
    // Set up initial query
    await client.query({
      queryFn: () => Promise.resolve('user1'),
      queryKey: ['users', 1]
    });

    // Create mutation with manual invalidation in onSuccess
    const updateUser = client.mutation({
      key: 'updateUser',
      mutationFn: (id: number, name: string) => Promise.resolve({ id, name }),
      onSuccess: result => {
        // Manually invalidate queries after successful mutation
        client.invalidate(['users', result.id]);
      }
    });

    // Execute mutation
    const result = await updateUser.mutate(1, 'updated');
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
});
