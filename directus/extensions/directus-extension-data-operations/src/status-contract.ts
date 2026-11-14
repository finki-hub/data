import { z } from 'zod';

import { isCalculation } from './coordination/domains.js';

// The answers of the status endpoint (status-endpoint.ts), declared once:
// the endpoint builds them (status-view.ts) and the
// dashboard panels parse them. Everything in them is a state, a code, a
// count, a timestamp, a declared name or a Studio link; never a record of
// a Moodle user, a file body, a token or a claim owner.

const text = z.string();
const maybeText = text.nullable();
const count = z.number().int().nonnegative();
const revision = z.number().int().nullable();

// A domain as the coordinator reports it; `current` is shown as idle.
export const domainStates = [
  'current',
  'pending',
  'running',
  'failed',
] as const;

const domainView = z.object({
  kind: text,
  label: text,
  name: text,
  state: z.enum(domainStates),
  waitingFor: z.array(text),
});

// One row of a key source: its key text, its own opt-in flag and whether
// it places public keys now (its generation may be unpublished).
const keyRowView = z.object({
  id: z.union([z.number().int(), text]),
  key: maybeText,
  link: text,
  placesKeys: z.boolean(),
  published: z.boolean(),
});

const keySourceView = z.object({
  collection: text,
  key: text,
  label: text,
  link: text,
  name: text,
  rows: z.array(keyRowView),
});

export const statusViewSchema = z.object({
  // The running claim: which domain, since when, whether it went stale.
  claim: z
    .object({
      domain: text,
      heartbeatAt: maybeText,
      label: text,
      stale: z.boolean(),
      startedAt: maybeText,
    })
    .nullable(),
  domains: z.array(domainView),
  historyIndex: z.object({
    countMismatches: count,
    entries: count,
    indexedUsers: count,
    memberships: count,
    users: count,
  }),
  importState: text,
  keySources: z.array(keySourceView),
  lastError: z
    .object({
      at: maybeText,
      blocking: z.boolean(),
      code: text,
      domain: maybeText,
      message: maybeText,
      retries: count,
      revision,
    })
    .nullable(),
  lastRun: z.object({
    finishedAt: maybeText,
    retries: count,
    startedAt: maybeText,
  }),
  revisions: z.object({ completed: count, requested: count, source: count }),
  // Each scheduled Flow and its last run within the look-back window.
  schedule: z.array(
    z.object({
      active: z.boolean(),
      ageSeconds: z.number().int().nullable(),
      id: text,
      lastRunAt: maybeText,
      name: text,
    }),
  ),
});

export type DomainView = z.infer<typeof domainView>;

export type KeySourceView = z.infer<typeof keySourceView>;

export type StatusView = z.infer<typeof statusViewSchema>;

// The data envelope of a Directus answer.
export const envelope = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({ data: schema });

// How often a panel reads the status again while work is in flight.
export const pollMs = 5_000;

// The longest pause between two reads after failed ones.
export const retryCapMs = 60_000;

// A refusal of the caller (not signed in, or not permitted): reading again
// does not change it.
export const isRefusal = (status: null | number): boolean =>
  status === 401 || status === 403;

// When a panel reads the status again, in milliseconds, or null for not
// until something asks: after a failed read that is no refusal, with a
// pause that doubles per failure up to retryCapMs; else every pollMs while
// work is in flight.
export const nextReadMs = ({
  busy,
  failures,
  refused,
}: {
  readonly busy: boolean;
  readonly failures: number;
  readonly refused: boolean;
}): null | number => {
  if (failures > 0 && !refused) {
    return Math.min(pollMs * 2 ** (failures - 1), retryCapMs);
  }
  return busy ? pollMs : null;
};

// Work in flight: a claim, a running domain, or a pending calculation the
// schedule picks up on its own.
export const isBusy = (status: null | StatusView): boolean =>
  status !== null &&
  (status.claim !== null ||
    status.domains.some(
      ({ name, state }) =>
        state === 'running' || (state === 'pending' && isCalculation(name)),
    ));
