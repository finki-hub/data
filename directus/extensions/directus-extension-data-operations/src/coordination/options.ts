import { z } from 'zod';

import { historyRowProblem } from '../history-contract.js';
import { pageTokenPattern } from '../page-state.js';
import { invalidOptionsText } from '../text.js';
import { claimTargets, coordinationDomains } from './domains.js';
import { coordinationError } from './errors.js';
import {
  errorMessageLength,
  maxRowsPerPage,
  pageSize,
  planSources,
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

// One match of a history line and a pattern mapping as the matcher stages
// it: the year its year pattern read, or null for an only-in-year mapping.
// The year is lineYear's `<start>/<start+1>`, start from -1 (an end year
// 0000) to 9999; one that names no academic year is staged too, and the
// completion's join on the label drops it, as resolveLines does.
const matchRowSchema = z.object({
  entry: z.number().int().positive(),
  pattern_mapping: z.number().int().positive(),
  year_label: z
    .string()
    .regex(/^(?:-1|\d{1,4})\/\d{1,5}$/u)
    .nullable(),
});

// One Moodle user of an index page with the distinct entries of its raw
// history, each exactly as the splitter emits it. A row that cannot be
// indexed is refused with its user id, so the operator knows whose raw
// history to fix; the text never quotes a label.
const historyRowSchema = z
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

const coordinatorInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('mark'),
    domains: z.preprocess(
      jsonish,
      z.array(domain).min(1).max(coordinationDomains.length),
    ),
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
    rows: z.preprocess(jsonish, z.array(matchRowSchema).max(maxRowsPerPage)),
    token,
  }),
  z.object({
    action: z.literal('index_page'),
    page: z.preprocess(blank, z.string().regex(pageTokenPattern)),
    rows: z.preprocess(jsonish, z.array(historyRowSchema).max(pageSize)),
    token,
  }),
  z.object({ action: z.literal('complete'), token }),
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

// Validates the template-resolved options of one operation run. Nothing
// here names a collection or carries SQL: domains, sources and actions are
// enumerations, tokens and pages are the coordinator's own identifiers. A
// refusal names at most five issues, each cut to a bounded length, however
// many rows or labels of a page are invalid (invalidOptionsText).
export const parseCoordinatorInput = (options: unknown): CoordinatorInput => {
  const parsed = coordinatorInputSchema.safeParse(options);
  if (parsed.success) {
    return parsed.data;
  }
  throw coordinationError(
    'INVALID_OPTIONS',
    invalidOptionsText(parsed.error.issues),
    { status: 400 },
  );
};
