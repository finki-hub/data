import { z } from 'zod';

import { pageTokenPattern } from '../page-state.js';
import { coordinationError } from './errors.js';
import {
  coordinationDomains,
  maxRowsPerPage,
  pageSources,
  publishedFiles,
} from './state.js';

// Studio stores an untouched option as null or an empty string, and a
// template such as {{ $trigger.body.token }} yields null for an absent
// key; all of these mean "not given".
const blank = (value: unknown): unknown =>
  value === null || value === '' ? undefined : value;

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

const flag = (value: unknown): unknown => {
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

export const countRowSchema = z.object({
  academic_year: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  course: z.number().int().positive(),
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
    domain: z.preprocess(blank, domain),
    retry: z
      .preprocess(flag, z.boolean().optional())
      .transform((value) => value ?? false),
  }),
  z.object({
    action: z.literal('plan_pages'),
    source: z.preprocess(blank, z.enum(pageSources)),
    token,
  }),
  z.object({
    action: z.literal('stage_page'),
    page: z.preprocess(blank, z.string().regex(pageTokenPattern)),
    rows: z.preprocess(jsonish, z.array(countRowSchema).max(maxRowsPerPage)),
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
// enumerations, tokens and pages are the coordinator's own identifiers.
export const parseCoordinatorInput = (options: unknown): CoordinatorInput => {
  const parsed = coordinatorInputSchema.safeParse(options);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`)
    .join('; ');
  throw coordinationError(
    'INVALID_OPTIONS',
    `Invalid coordination options (${issues}). Actions: ${coordinatorActions.join(', ')}.`,
    { status: 400 },
  );
};
