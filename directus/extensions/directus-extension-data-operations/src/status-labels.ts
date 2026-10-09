import type { CheckView, StatusView } from './status-contract.js';

import {
  domainLabel,
  isClaimDomain,
  stateLabels,
} from './coordination/domains.js';
import { humanize } from './managed-flows.js';

// How the dashboard names and colours a state, an outcome or a severity
// of the status read. Unknown values keep their own name and a neutral
// tone. Timestamps arrive as ISO-8601 text rendered by the database and
// ages as seconds by its clock, so nothing here parses a date.

export type Tone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

const tones: Readonly<Record<string, Tone>> = {
  blocker: 'danger',
  completed: 'success',
  current: 'success',
  failed: 'danger',
  importing: 'info',
  partial: 'warning',
  pending: 'warning',
  promoting: 'info',
  ready: 'warning',
  running: 'info',
  skipped: 'warning',
  uploaded: 'success',
  validating: 'info',
  warning: 'warning',
};

// The stored states keep the one label Studio shows too (stateLabels); a
// domain whose derived rows are those of the current source revision is
// idle: nothing waits for it.
const labels: Readonly<Record<string, string>> = {
  ...stateLabels,
  current: 'Idle',
};

export const toneOf = (state: null | string): Tone =>
  state === null ? 'neutral' : (tones[state] ?? 'neutral');

export const stateLabel = (state: null | string): string =>
  state === null ? 'Never' : (labels[state] ?? humanize(state));

// "2026-09-24T16:20:01.123Z" as "2026-09-24 16:20:01 UTC".
export const instantText = (iso: null | string): string =>
  iso === null ? '--' : `${iso.replace('T', ' ').slice(0, 19)} UTC`;

// The one marker of a claim whose process stopped heartbeating.
export const staleText = (stale: boolean): string => (stale ? ' (stale)' : '');

// The label of a domain the status names: a claim domain's declared
// label, "unknown" for none, any other name as it is.
export const domainText = (domain: null | string): string => {
  if (domain === null) {
    return 'unknown';
  }
  return isClaimDomain(domain) ? domainLabel(domain) : domain;
};

// Seconds as "12 s", "4 min" or "3 h".
export const ageText = (seconds: null | number): string => {
  if (seconds === null) {
    return '--';
  }
  if (seconds < 120) {
    return `${String(Math.max(0, seconds))} s`;
  }
  return seconds < 7_200
    ? `${String(Math.floor(seconds / 60))} min`
    : `${String(Math.floor(seconds / 3_600))} h`;
};

const rank = (check: CheckView): number => {
  if (check.count === 0) {
    return 2;
  }
  return check.severity === 'blocker' ? 0 : 1;
};

// Positive blockers first, then positive warnings, then the clear checks,
// each group in registry order.
export const orderedChecks = (checks: readonly CheckView[]): CheckView[] =>
  checks
    .map((check, index) => ({ check, index }))
    .toSorted(
      (left, right) =>
        rank(left.check) - rank(right.check) || left.index - right.index,
    )
    .map(({ check }) => check);

// The words of a Studio link to the records behind a check: its
// incomplete-data bookmark while it exists, else its collection.
export const checkLinkText = (check: CheckView): string =>
  check.review ?? humanize(check.page);

// Bytes as "5.3 kB".
export const bytesText = (bytes: null | number): string => {
  if (bytes === null) {
    return '--';
  }
  return bytes < 1_000
    ? `${String(bytes)} B`
    : `${(bytes / 1_000).toFixed(1)} kB`;
};

// What a Run button waits for: the server's claim, or a run another
// panel of this page started (it takes the claim), or nothing.
export const waitingText = (
  claim: StatusView['claim'],
  otherRun: boolean,
): null | string => {
  if (claim === null) {
    return otherRun ? 'run in progress on this page' : null;
  }
  return `claim held by ${claim.label}${staleText(claim.stale)}`;
};
