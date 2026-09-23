import { z } from 'zod';

import { historyRowProblem } from '../history-contract.js';
import { pageTokenPattern } from '../page-state.js';
import { coordinationError } from './errors.js';
import {
  claimTargets,
  coordinationDomains,
  errorMessageLength,
  maxRowsPerPage,
  pageSize,
  planSources,
  publishedFiles,
} from './state.js';

// Studio stores an untouched option as null or an empty string, a template
// such as {{ $trigger.body.token }} yields null for a null key and the
// literal text "undefined" for a key that is absent altogether (Directus
// renders an unresolved exact template explicitly); all of these mean
// "not given".
const absent: ReadonlySet<unknown> = new Set(['', null, 'undefined']);

export const blank = (value: unknown): unknown =>
  absent.has(value) ? undefined : value;

const maxJsonLength = 2_000_000;

// JSON-typed options arrive as parsed values from an exact template and as
// text when typed into a code field.
const jsonish = (value: unknown): unknown => {
  const present = blank(value);
  if (typeof present !== 'string' || present.length > maxJsonLength) {
    return present;
  }
  try {
    return JSON.parse(present);
  } catch {
    return present;
  }
};

export const flag = (value: unknown): unknown => {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return blank(value);
};

const domain = z.enum(coordinationDomains);
const token = z.preprocess(blank, z.uuid());
const outcome = z.string().max(120);

// A failure message never refuses the fail it rides on: text is cut to the
// kept length, anything else (a whole failure record resolved by an exact
// template) is kept as its JSON text, and an absent message is null.
const failureMessage = z
  .preprocess((value) => {
    const present = blank(value);
    if (present === undefined || typeof present === 'string') {
      return present;
    }
    return JSON.stringify(present);
  }, z.string().optional())
  .transform((value) =>
    value === undefined ? null : value.slice(0, errorMessageLength),
  );

export const countRowSchema = z.object({
  academic_year: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  course: z.number().int().positive(),
});

// One Moodle user of an index page with the distinct entries of its raw
// history, each exactly as the splitter emits it. A row that cannot be
// indexed is refused with its user id, so the operator knows whose raw
// history to fix; the text never quotes a label.
export const historyRowSchema = z
  .object({
    entries: z.array(z.string()),
    id: z.number().int().positive(),
  })
  .superRefine((row, context) => {
    const problem = historyRowProblem(row.entries);
    if (problem !== null) {
      context.addIssue({
        code: 'custom',
        message: `Moodle user ${row.id}: ${problem}`,
        path: ['entries'],
      });
    }
  });

const filesSchema = z.object(
  Object.fromEntries(
    publishedFiles.map((file) => [file, outcome.nullable().optional()]),
  ) as Record<
    (typeof publishedFiles)[number],
    z.ZodOptional<z.ZodNullable<typeof outcome>>
  >,
);

export const coordinatorInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('mark'),
    domains: z.preprocess(jsonish, z.array(domain).min(1).max(3)),
  }),
  z.object({
    action: z.literal('claim'),
    domain: z.preprocess(blank, z.enum(claimTargets)),
    retry: z
      .preprocess(flag, z.boolean().optional())
      .transform((value) => value ?? false),
  }),
  z.object({
    action: z.literal('plan_pages'),
    source: z.preprocess(blank, z.enum(planSources)),
    token,
  }),
  z.object({
    action: z.literal('stage_page'),
    page: z.preprocess(blank, z.string().regex(pageTokenPattern)),
    rows: z.preprocess(jsonish, z.array(countRowSchema).max(maxRowsPerPage)),
    token,
  }),
  z.object({
    action: z.literal('index_page'),
    page: z.preprocess(blank, z.string().regex(pageTokenPattern)),
    rows: z.preprocess(jsonish, z.array(historyRowSchema).max(pageSize)),
    token,
  }),
  z.object({
    action: z.literal('complete'),
    files: z.preprocess(jsonish, filesSchema.optional()),
    token,
  }),
  z.object({
    action: z.literal('fail'),
    code: z
      .preprocess(blank, z.string().regex(/^[A-Za-z]\w{0,63}$/u))
      .transform((value) => value.toUpperCase()),
    message: failureMessage,
    token,
  }),
  z.object({ action: z.literal('heartbeat'), token }),
  z.object({ action: z.literal('status') }),
]);

export type CoordinatorInput = z.infer<typeof coordinatorInputSchema>;

export const coordinatorActions = coordinatorInputSchema.options.map(
  (option) => option.shape.action.value,
);

// A refusal names at most this many issues, each cut to a bounded length,
// however many rows or labels of a page are invalid.
const shownIssues = 5;
const issueLength = 240;

const describeIssues = (issues: readonly z.core.$ZodIssue[]): string => {
  const shown = issues
    .slice(0, shownIssues)
    .map((issue) =>
      `${issue.path.join('.') || 'options'}: ${issue.message}`.slice(
        0,
        issueLength,
      ),
    );
  const more = issues.length - shown.length;
  if (more === 0) {
    return shown.join('; ');
  }
  const noun = more === 1 ? 'issue' : 'issues';
  return `${shown.join('; ')}; and ${more} more ${noun}`;
};

// Validates the template-resolved options of one operation run. Nothing
// here names a collection or carries SQL: domains, sources and actions are
// enumerations, tokens and pages are the coordinator's own identifiers.
export const parseCoordinatorInput = (options: unknown): CoordinatorInput => {
  const parsed = coordinatorInputSchema.safeParse(options);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = describeIssues(parsed.error.issues);
  throw coordinationError(
    'INVALID_OPTIONS',
    `Invalid coordination options (${issues}). Actions: ${coordinatorActions.join(', ')}.`,
    { status: 400 },
  );
};
