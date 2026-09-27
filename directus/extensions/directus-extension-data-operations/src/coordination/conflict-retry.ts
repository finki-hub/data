import { randomInt } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';

// PostgreSQL's deadlock_detected (SQLSTATE 40P01) and serialization_failure
// (40001): the database rolled the whole transaction back, so running it
// again from its first statement is safe. Every token-bearing action that
// retries (guarded, action-support.ts) reads the singleton FOR UPDATE and
// checks its claim before it writes, so an attempt after a lost or
// superseded claim refuses as the first one would have.
const transactionConflict = z.object({ code: z.enum(['40P01', '40001']) });

export const isTransactionConflict = (error: unknown): boolean =>
  transactionConflict.safeParse(error).success;

// How many times one coordinator transaction runs at most.
export const conflictAttempts = 3;

// The wait before a retry: 50-100 ms before the first, 100-200 ms before
// the second, jittered so two losers do not meet again at once. Directus
// retries its own item transactions after 100, 200 and 400 ms.
export const conflictBackoffMs = (retry: number): number => {
  const base = 50 * 2 ** (retry - 1);
  return base + randomInt(base + 1);
};

// Runs the transaction, and again after a transaction conflict, at most
// conflictAttempts times; the transaction learns how often it was retried.
// Any other error, and a conflict on the last attempt, is thrown as it was.
export const retryingConflicts = async <T>(
  transaction: (retries: number) => Promise<T>,
  retries = 0,
): Promise<T> => {
  try {
    return await transaction(retries);
  } catch (error) {
    if (retries + 1 >= conflictAttempts || !isTransactionConflict(error)) {
      throw error;
    }
    await pause(conflictBackoffMs(retries + 1));
    return retryingConflicts(transaction, retries + 1);
  }
};
