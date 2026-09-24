import { z } from 'zod';

import { humanize } from './managed-flows.js';

// How the dashboard panels read what Directus answered them: the refusal
// of a request (Directus's own error or a Flow's Throw Error step), a
// bounded summary of what a Flow answered, and the collections GET
// /permissions/me says the caller may read. Nothing here keeps or logs a
// payload.

const errorAnswer = z.object({
  response: z.object({
    data: z
      .object({
        errors: z
          .array(
            z.object({
              extensions: z
                .looseObject({ code: z.string().optional() })
                .optional(),
              message: z.string().optional(),
            }),
          )
          .min(1),
      })
      .optional(),
    status: z.number().int(),
  }),
});

export type Refusal = {
  readonly code: string;
  readonly message: string;
  readonly status: null | number;
};

const maxText = 600;

const bounded = (value: string): string =>
  value.length > maxText ? `${value.slice(0, maxText)}…` : value;

// The code and message Directus (or the Flow's own Throw Error step)
// answered, bounded; a network failure without an answer says so.
export const refusalOf = (error: unknown): Refusal => {
  const parsed = errorAnswer.safeParse(error);
  if (!parsed.success) {
    return {
      code: 'NO_ANSWER',
      message: 'Directus did not answer; check the connection and try again.',
      status: null,
    };
  }
  const { data, status } = parsed.data.response;
  const [first] = data?.errors ?? [];
  return {
    code: first?.extensions?.code ?? `HTTP_${String(status)}`,
    message: bounded(
      first?.message ?? `Directus answered HTTP ${String(status)}.`,
    ),
    status,
  };
};

export type SummaryLine = { readonly label: string; readonly text: string };

const maxLines = 10;

const lineText = (value: unknown): null | string => {
  if (typeof value === 'string') {
    return bounded(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${String(value.length)} entries`;
  }
  return value !== null && typeof value === 'object'
    ? `${String(Object.keys(value).length)} entries`
    : null;
};

// A bounded reading of what the Flow answered: its top-level values as
// text (a list or an object only by its size), at most ten lines.
export const answerSummary = (answer: unknown): SummaryLine[] => {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    const text = lineText(answer);
    return text === null ? [] : [{ label: 'Answer', text }];
  }
  return Object.entries(answer)
    .flatMap(([key, value]) => {
      const text = lineText(value);
      return text === null ? [] : [{ label: humanize(key), text }];
    })
    .slice(0, maxLines);
};

// GET /permissions/me: per collection, whether each action is allowed.
const permissionsMe = z.object({
  data: z.record(
    z.string(),
    z.looseObject({
      read: z.looseObject({ access: z.string() }).optional(),
    }),
  ),
});

// The collections the caller may read, from the answer of GET
// /permissions/me; none when the answer is not understood.
export const readableCollections = (answer: unknown): ReadonlySet<string> => {
  const parsed = permissionsMe.safeParse(answer);
  return new Set(
    parsed.success
      ? Object.entries(parsed.data.data).flatMap(([collection, actions]) =>
          actions.read !== undefined && actions.read.access !== 'none'
            ? [collection]
            : [],
        )
      : [],
  );
};
