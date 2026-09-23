import type { ExportDefinition, IssueCode, ReadinessCheck } from './types.js';

import { exportError } from './errors.js';

// The readiness facts and checks of the project rather than of one file:
// the calculation states of the coordinator, the Task 10 snapshot facts and
// the one-time conversion. Their codes are declared here once, like every
// check's codes, so a definition can never redeclare one of them with
// another kind or page.

export const calculationDomains = ['history_index', 'enrollments'] as const;

// The coordinator facts readiness reads: the source revision, the
// fingerprint of the last accepted calculation and the state of each
// calculation domain (current, pending, running or failed).
export type CoordinationFacts = {
  readonly calculation: null | string;
  readonly domains: Readonly<Record<string, string>>;
  readonly revision: number;
};

// One counted issue, with the declaration of its code.
export type Finding = {
  readonly code: string;
  readonly count: number;
  readonly issue: IssueCode;
};

// Task 10's snapshot facts: the import state and whether the active
// Moodle users still equal the last promoted snapshot (null before the
// first promotion).
export type SnapshotFacts = {
  readonly activeMatchesPromotion: boolean | null;
  readonly activeRows: number;
  readonly state: string;
};

const operations: IssueCode = {
  collection: 'data_operations',
  kind: 'blocker',
};

const snapshotWarning: IssueCode = {
  collection: 'data_operations',
  kind: 'warning',
};

const notCurrent = ['failed', 'pending', 'running'] as const;

// The codes of the coordinator and snapshot facts. A calculation that is
// not current blocks (its derived rows are not those of the current source
// revision); an import in flight or failed blocks; a staged snapshot,
// active users edited outside the snapshot workflow and a project whose
// users never came through a promotion only warn: edits of Moodle users
// are counted like any other source edit.
export const factCodes: Readonly<Record<string, IssueCode>> = {
  ...Object.fromEntries(
    calculationDomains.flatMap((domain) =>
      notCurrent.map((state) => [`${domain}_${state}`, operations]),
    ),
  ),
  active_snapshot_edited: snapshotWarning,
  snapshot_import_failed: operations,
  snapshot_import_running: operations,
  snapshot_never_promoted: snapshotWarning,
  snapshot_staged: snapshotWarning,
};

// A finding of a declared fact code; `what` names the fact in a refusal.
const fact = (code: string, count: number, what = code): Finding => {
  const issue = factCodes[code];
  if (issue === undefined) {
    throw exportError('INVALID_READ', `Readiness has no code for ${what}`);
  }
  return { code, count, issue };
};

export const coordinationFindings = (facts: CoordinationFacts): Finding[] =>
  calculationDomains.flatMap((domain) => {
    const state = facts.domains[domain];
    if (state === 'current') {
      return [];
    }
    return [
      fact(
        `${domain}_${String(state)}`,
        1,
        `the state the coordinator status names for ${domain}`,
      ),
    ];
  });

const importing: ReadonlySet<string> = new Set([
  'importing',
  'promoting',
  'validating',
]);

export const snapshotFindings = (facts: SnapshotFacts): Finding[] => [
  fact('snapshot_import_running', Number(importing.has(facts.state))),
  fact('snapshot_import_failed', Number(facts.state === 'failed')),
  fact('snapshot_staged', Number(facts.state === 'ready')),
  fact(
    'active_snapshot_edited',
    Number(facts.activeMatchesPromotion === false),
  ),
  fact(
    'snapshot_never_promoted',
    Number(facts.activeMatchesPromotion === null && facts.activeRows > 0),
  ),
];

// A ledger step of the one-time conversion that is still running or
// failed leaves the relational rows partial.
export const conversionCheck: ReadinessCheck = {
  codes: {
    conversion_incomplete: { collection: 'migration_ledger', kind: 'blocker' },
  },
  evaluate: (sources) => ({
    conversion_incomplete: (sources['steps'] ?? []).length,
  }),
  reads: {
    steps: {
      collection: 'migration_ledger',
      fields: ['id'],
      filter: { status: { _neq: 'completed' } },
      sort: ['id'],
    },
  },
};

// The checks every assessment runs beside the checks of the definitions.
// A new project-wide check is appended here; the structural rules and the
// private-read tests cover it like any definition's check.
export const globalChecks: readonly ReadinessCheck[] = [conversionCheck];

// Every distinct check of an assessment: the global ones, then each
// definition's in order. A check object two definitions share is run and
// counted once.
export const readinessChecks = (
  definitions: readonly ExportDefinition[],
  globals: readonly ReadinessCheck[] = globalChecks,
): readonly ReadinessCheck[] => [
  ...new Set([...globals, ...definitions.flatMap(({ checks }) => checks)]),
];
