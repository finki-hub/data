import type { StatusView } from './status-contract.js';

import { scheduleLookBackMinutes } from './managed-flows.js';
import {
  ageText,
  domainText,
  instantText,
  staleText,
} from './status-labels.js';
import { factsText } from './text.js';

// The fact lines of the status panels, each `Label: value · Label: value`
// (factsText): the revisions and the scheduled Flows, the running claim,
// the last run, the last publication, the Moodle snapshot counts, the last
// failure and the readiness summary. A value the status does not hold yet
// reads "--".

type Fact = readonly [label: string, value: number | string];

type ScheduledRun = StatusView['schedule'][number];

// A run's transaction retries after a database conflict, as a fact of its
// line; none at zero.
export const retriesFacts = (retries: number): Fact[] =>
  retries === 0 ? [] : [['Retries', retries]];

// When a scheduled Flow last ran, within the look-back window of the
// status read.
const scheduledText = ({
  active,
  ageSeconds,
  lastRunAt,
}: ScheduledRun): string => {
  const ran =
    lastRunAt === null
      ? `no run in ${String(scheduleLookBackMinutes)} min`
      : `${ageText(ageSeconds)} ago`;
  return active ? ran : `${ran} (inactive)`;
};

// The toolbar of the status panel: the source and completed revisions and
// each scheduled Flow's last run.
export const toolbarText = ({
  revisions,
  schedule,
}: Pick<StatusView, 'revisions' | 'schedule'>): string =>
  factsText([
    ['Source revision', revisions.source],
    ['Completed revision', revisions.completed],
    ...schedule.map((run): Fact => [run.name, scheduledText(run)]),
  ]);

// The domains a calculation waits for, by their labels; nothing when it
// waits for none.
export const waitsForText = (waitingFor: readonly string[]): string =>
  waitingFor.length === 0
    ? ''
    : factsText([['Waits for', waitingFor.map(domainText).join(', ')]]);

// The running claim: its domain, since when, and whether it went stale.
export const claimText = (claim: NonNullable<StatusView['claim']>): string =>
  factsText([
    [
      'Running',
      `${claim.label} since ${instantText(claim.startedAt)}${staleText(claim.stale)}`,
    ],
  ]);

// The last completed run, start to end, with its retries.
export const lastRunText = ({
  finishedAt,
  retries,
  startedAt,
}: StatusView['lastRun']): string =>
  factsText([
    [
      'Last run',
      startedAt === null
        ? '--'
        : `${instantText(startedAt)} – ${instantText(finishedAt)}`,
    ],
    ...retriesFacts(retries),
  ]);

// The Moodle snapshot counts of the status panel.
export const snapshotText = ({
  countMismatches,
  entries,
  indexedUsers,
  users,
}: StatusView['historyIndex']): string =>
  factsText([
    ['Users', users],
    ['Indexed', indexedUsers],
    ['History lines', entries],
    ['Course count mismatches', countMismatches],
  ]);

// The facts of the last failure after its code: domain, revision, when,
// and its retries.
export const lastErrorText = ({
  at,
  domain,
  retries,
  revision,
}: NonNullable<StatusView['lastError']>): string =>
  factsText([
    ['Domain', domainText(domain)],
    ['Revision', revision ?? '--'],
    ['At', instantText(at)],
    ...retriesFacts(retries),
  ]);
