import { createContext, Script } from 'node:vm';
import { z } from 'zod';

import { isValidPattern } from './labels.js';

// Runs a stored enrollment expression over the Moodle histories of the
// conversion proposal with a deadline, the way Run Script bounds it in the
// Flow (FLOWS_RUN_SCRIPT_TIMEOUT, 10 s by default): a catastrophic
// expression is reported as timed out instead of holding the dry-run
// forever. The test is the checkpoint's: new RegExp(pattern, 'u') over the
// whole raw history, once per user.

export const proposalPatternTimeoutMs = 10_000;

export type MatchOutcome =
  | { readonly ids: ReadonlySet<number>; readonly kind: 'matched' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'timed_out' };

export type Matcher = (pattern: string) => MatchOutcome;

export type MatchUser = {
  readonly Courses: null | string;
  readonly id: number;
};

const matchScript = new Script(`(function () {
  const matcher = new RegExp(pattern, 'u');
  const matched = [];
  for (let index = 0; index < histories.length; index += 1) {
    const text = histories[index];
    if (typeof text === 'string' && matcher.test(text)) {
      matched.push(index);
    }
  }
  return matched;
})()`);

const matchedIndexes = z.array(z.number().int().nonnegative());
const timedOut = z.object({ code: z.literal('ERR_SCRIPT_EXECUTION_TIMEOUT') });

// One matcher over one set of users. The expression is compiled first on
// its own (compiling never runs it), then run in an isolated context that
// V8 terminates at the deadline; the context sees the histories and the
// pattern text only.
export const boundedMatcher = (
  users: readonly MatchUser[],
  timeoutMs: number = proposalPatternTimeoutMs,
): Matcher => {
  const sandbox = {
    histories: users.map(({ Courses }) => Courses),
    pattern: '',
  };
  const context = createContext(sandbox);
  return (pattern) => {
    if (!isValidPattern(pattern)) {
      return { kind: 'invalid' };
    }
    sandbox.pattern = pattern;
    try {
      const indexes = matchedIndexes.parse(
        matchScript.runInContext(context, { timeout: timeoutMs }),
      );
      return {
        ids: new Set(indexes.flatMap((index) => users[index]?.id ?? [])),
        kind: 'matched',
      };
    } catch (error) {
      if (timedOut.safeParse(error).success) {
        return { kind: 'timed_out' };
      }
      throw error;
    }
  };
};
