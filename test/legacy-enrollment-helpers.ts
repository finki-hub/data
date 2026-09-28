import { runInNewContext } from 'node:vm';
import { z } from 'zod';

import type { ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import type { FakeCoordination } from './data-coordination-helpers.js';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { claimStaleAfterMs } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import {
  academicYears,
  makeSyntheticDataset,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import { checkOf } from './import-plan-helpers.js';

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

export type LegacyUser = { readonly Courses: unknown; readonly id: number };

export type LegacyRule = {
  readonly academic_year: number;
  readonly course: number;
  readonly id: number;
  readonly pattern: unknown;
};

const bytesOf = (texts: readonly unknown[]): number =>
  texts.reduce<number>(
    (total, text) =>
      total + (typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0),
    0,
  );

const rangeOf = (ids: readonly number[]) => ({
  from: Math.min(...ids),
  rows: ids.length,
  to: Math.max(...ids),
});

// The checked legacy page (check_page) of the given users and rules, as
// the plan stored it: ranges, history bytes and pattern bytes.
export const checkedPage = (
  users: readonly LegacyUser[],
  rules: readonly LegacyRule[],
) => ({
  claim,
  revision: 7,
  rules: {
    ...rangeOf(rules.map(({ id }) => id)),
    bytes: bytesOf(rules.map(({ pattern }) => pattern)),
  },
  token: 'p0002',
  users: {
    ...rangeOf(users.map(({ id }) => id)),
    bytes: bytesOf(users.map(({ Courses }) => Courses)),
  },
});

// The Moodle users of a dataset as read_users answers them.
export const usersOf = (dataset: SyntheticDataset): LegacyUser[] =>
  dataset.moodle_users.map((user) => ({
    Courses: user['Courses'],
    id: user.id,
  }));

const yearLabels: readonly string[] = academicYears;

export const yearId = (label: string): number => yearLabels.indexOf(label) + 1;

// The legacy_regex rules the workbook import seeds from a dataset: the
// check's candidate rule of every course and academic year (the last
// pattern of the workbook, else the literal `<name>-<year>` default), one
// id each in course, year order.
export const seededRules = async (
  dataset: SyntheticDataset = makeSyntheticDataset(),
): Promise<LegacyRule[]> =>
  checkOf(dataset)
    .candidates.courses.flatMap((course) =>
      course.rules.map((rule) => ({
        academic_year: yearId(rule.academicYear),
        course: course.id,
        pattern: rule.pattern,
      })),
    )
    .map((rule, index) => ({ ...rule, id: index + 1 }));

export const context = (fake: FakeCoordination): ActionContext => ({
  owner: 'process-a',
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

const claimed = z.object({ claimed: z.literal(true), token: z.string() });

// Settles the history index of an empty fake, marks the rules changed and
// claims enrollments; answers the claim token.
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
  fake.sourceWrite('course_enrollment_rules');
  return claimed.parse(
    await runAction(
      { action: 'claim', domain: 'enrollments', retry: false },
      context(fake),
    ),
  ).token;
};
