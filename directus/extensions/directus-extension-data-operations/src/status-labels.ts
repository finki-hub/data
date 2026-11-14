import type { StatusView } from './status-contract.js';

import {
  domainLabel,
  isClaimDomain,
  stateLabels,
} from './coordination/domains.js';
import { humanize } from './managed-flows.js';

// How the dashboard names and colours a state of the status read. Unknown values keep their own name and a neutral
// tone. Timestamps arrive as ISO-8601 text rendered by the database and
// ages as seconds by its clock, so nothing here parses a date.

export type Tone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

const tones: Readonly<Record<string, Tone>> = {
  completed: 'success',
  current: 'success',
  failed: 'danger',
  importing: 'info',
  pending: 'warning',
  promoting: 'info',
  ready: 'warning',
  running: 'info',
  validating: 'info',
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

// A collection as the dashboard names it: by the name Studio shows for it
// (its label, read from the app; studio-name.ts), else by its humanized
// key, as for a collection the app does not list.
export const collectionText = (
  collection: string,
  studioName?: string,
): string => studioName ?? humanize(collection);

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
