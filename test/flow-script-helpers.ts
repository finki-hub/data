import { runInNewContext } from 'node:vm';
import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import type { FakeCoordination } from './data-coordination-helpers.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { claimStaleAfterMs } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';

export const claim = '8c0f1a52-3b4d-4e6f-9a7b-1c2d3e4f5a6b';

// Runs a Flow script body the way the Run Script operation does: the body
// assigns module.exports, which receives the whole data chain.
export const runScript = (code: string, data: unknown): unknown => {
  const sandbox: { module: { exports: unknown } } = {
    module: { exports: undefined },
  };
  runInNewContext(code, sandbox);
  const script = sandbox.module.exports;
  if (typeof script !== 'function') {
    throw new TypeError('The script must assign module.exports');
  }
  return (script as (input: unknown) => unknown)(data);
};

// The message of the error a script threw (from the sandbox realm).
export const refusalOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return z.object({ message: z.string() }).parse(error).message;
  }
  throw new Error('The script answered instead of refusing');
};

export const context = (fake: FakeCoordination): ActionContext => ({
  owner: 'process-a',
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

const claimed = z.object({ claimed: z.literal(true), token: z.string() });

// Settles the history index of an empty fake, marks the pattern mappings
// changed and claims enrollments; answers the claim token.
export const claimEnrollments = async (
  fake: FakeCoordination,
): Promise<string> => {
  const history = claimed.parse(
    await runAction(
      { action: 'claim', domain: 'history_index', retry: false },
      context(fake),
    ),
  ).token;
  await runAction(
    { action: 'plan_pages', source: 'history', token: history },
    context(fake),
  );
  await runAction({ action: 'complete', token: history }, context(fake));
  fake.sourceWrite('moodle_pattern_mappings');
  return claimed.parse(
    await runAction(
      { action: 'claim', domain: 'enrollments', retry: false },
      context(fake),
    ),
  ).token;
};
