import { z } from 'zod';

import { courseLimit, courseNameLength, searchLength } from './limits.js';
import { nativeFilter } from './native-filter.js';

// The criteria of a Search request, and the one line that refuses them:
// `Invalid criteria: <field>: <reason>`. The reasons are Search's own,
// because the library names array lengths in its own words and reports a
// failed filter union as "Invalid input" without the key it refused.

const sorts = ['Name', 'Courses Count', '-Courses Count'] as const;

const courseNames = z
  .array(z.string().min(1).max(courseNameLength))
  .max(courseLimit);

export const criteriaSchema = z.object({
  exclude: courseNames,
  filter: nativeFilter.nullish(),
  include: courseNames,
  page: z.number().int().min(1),
  search: z.string().max(searchLength).nullish(),
  sort: z.enum(sorts).default('Name'),
});

type Field = keyof typeof criteriaSchema.shape;

type Issue = z.core.$ZodIssue;

// How much of a refused filter key the line quotes.
const keyLength = 100;

// A key no filter accepts: an operator outside the list, a quantifier or
// an implicit relation. A group (`_and`, `_or`) is accepted; a field name
// is refused only by what it holds.
const unsupported = (key: string): boolean =>
  key.includes('$') || (key.startsWith('_') && key !== '_and' && key !== '_or');

// The keys an issue names, through every branch of a failed union.
const namedKeys = (issue: Issue): string[] => {
  if (issue.code === 'invalid_key') {
    return issue.path.slice(-1).map(String);
  }
  if (issue.code === 'invalid_union') {
    return issue.errors.flat().flatMap(namedKeys);
  }
  return issue.code === 'unrecognized_keys' ? issue.keys : [];
};

const filterReason = (issue: Issue): string => {
  if (issue.code === 'custom') {
    return issue.message;
  }
  const key = namedKeys(issue).find(unsupported);
  return key === undefined
    ? 'unsupported condition'
    : `unsupported key ${key.slice(0, keyLength)}`;
};

// A course list, or one course name of it.
const namesReason = (issue: Issue): string => {
  if (issue.path.length === 1) {
    return issue.code === 'too_big'
      ? `max ${String(courseLimit)} courses`
      : 'expected a list of course names';
  }
  if (issue.code === 'too_small') {
    return 'empty';
  }
  return issue.code === 'too_big'
    ? `max ${String(courseNameLength)} characters`
    : 'expected a course name';
};

const reasons: Readonly<Record<Field, (issue: Issue) => string>> = {
  exclude: namesReason,
  filter: filterReason,
  include: namesReason,
  page: () => 'expected an integer >= 1',
  search: (issue) =>
    issue.code === 'too_big'
      ? `max ${String(searchLength)} characters`
      : 'expected text',
  sort: () =>
    `expected ${sorts.slice(0, -1).join(', ')} or ${sorts.slice(-1).join('')}`,
};

const isField = (key: PropertyKey | undefined): key is Field =>
  typeof key === 'string' && Object.hasOwn(reasons, key);

// Refused criteria at one place: a field, or one course of a list.
export const invalidCriteria = (place: string, reason: string): string =>
  `Invalid criteria: ${place}: ${reason}`;

// The first issue of refused criteria as its line, then " (+N more)" for
// the others. A filter is placed as a whole: its keys are the caller's.
export const criteriaProblem = (error: z.ZodError): string => {
  const [issue, ...others] = error.issues;
  const field = issue?.path[0];
  const more = others.length > 0 ? ` (+${String(others.length)} more)` : '';
  if (issue === undefined || !isField(field)) {
    return `Invalid criteria: expected an object${more}`;
  }
  const place = field === 'filter' ? field : issue.path.map(String).join('.');
  return `${invalidCriteria(place, reasons[field](issue))}${more}`;
};
