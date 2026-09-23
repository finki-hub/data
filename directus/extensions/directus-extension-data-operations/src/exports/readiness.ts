import type {
  ExportDefinition,
  IssueCode,
  IssueCounts,
  ReadinessCheck,
} from './types.js';

import { rowsOf, sharedReader, type SourceReader } from './engine.js';
import { exportError } from './errors.js';
import {
  type CoordinationFacts,
  coordinationFindings,
  type Finding,
  readinessChecks,
  type SnapshotFacts,
  snapshotFindings,
} from './global-checks.js';

// Whether the public files can be prepared exactly at the current source
// revision: the calculations current, no snapshot import in flight or
// failed, the one-time conversion complete, and every check of every
// export definition. The answer holds codes, counts and Studio pages
// only, never a name, a label or a record.

export type ReadinessAnswer = {
  readonly blockers: readonly string[];
  readonly issueCounts: IssueCounts;
  readonly links: Readonly<Record<string, string>>;
  readonly ready: boolean;
  readonly revision: number;
  readonly warnings: readonly string[];
};

export type ReadinessDeps = {
  readonly coordination: () => Promise<CoordinationFacts>;
  readonly reader: SourceReader;
  readonly snapshot: () => Promise<SnapshotFacts>;
};

const checkFindings = (
  check: ReadinessCheck,
  counts: IssueCounts,
): Finding[] => {
  for (const [code, count] of Object.entries(counts)) {
    if (
      !Object.hasOwn(check.codes, code) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw exportError(
        'INVALID_DEFINITION',
        `A readiness check answered ${code}, which it does not declare, or no whole count`,
      );
    }
  }
  return Object.entries(check.codes).map(([code, issue]) => ({
    code,
    count: counts[code] ?? 0,
    issue,
  }));
};

// One decided code: its declaration and the sum of its counts. A code
// counted by two checks adds up; declared with two kinds or pages it is
// refused, never decided by whichever came last.
const decided = (code: string, findings: readonly Finding[]): Finding[] => {
  const [first] = findings;
  if (first === undefined) {
    return [];
  }
  const { issue } = first;
  if (
    findings.some(
      (finding) =>
        finding.issue.kind !== issue.kind ||
        finding.issue.collection !== issue.collection,
    )
  ) {
    throw exportError(
      'INVALID_DEFINITION',
      `The readiness code ${code} is declared with two kinds or pages`,
    );
  }
  const count = findings.reduce((sum, finding) => sum + finding.count, 0);
  return count > 0 ? [{ code, count, issue }] : [];
};

// The answer over every finding: codes with a positive count, blockers
// and warnings each in the order the checks declare them.
export const decideReadiness = (
  revision: number,
  findings: readonly Finding[],
): ReadinessAnswer => {
  const positive = Map.groupBy(findings, ({ code }) => code)
    .entries()
    .flatMap(([code, group]) => decided(code, group))
    .toArray();
  const codesOf = (kind: IssueCode['kind']) =>
    positive.filter(({ issue }) => issue.kind === kind).map(({ code }) => code);
  const blockers = codesOf('blocker');
  return {
    blockers,
    issueCounts: Object.fromEntries(
      positive.map(({ code, count }) => [code, count]),
    ),
    links: Object.fromEntries(
      positive.map(({ code, issue }) => [
        code,
        `/admin/content/${issue.collection}`,
      ]),
    ),
    ready: blockers.length === 0,
    revision,
    warnings: codesOf('warning'),
  };
};

// Reads the coordinator and snapshot facts first, then runs every distinct
// check through one reader (a read two checks share is made once);
// answers the decision and the facts it was taken at.
export const assessReadiness = async (
  definitions: readonly ExportDefinition[],
  deps: ReadinessDeps,
): Promise<{
  readonly answer: ReadinessAnswer;
  readonly coordination: CoordinationFacts;
}> => {
  const coordination = await deps.coordination();
  const findings = [
    ...coordinationFindings(coordination),
    ...snapshotFindings(await deps.snapshot()),
  ];
  const reader = sharedReader(deps.reader);
  for (const check of readinessChecks(definitions)) {
    const sources: Record<string, ReturnType<typeof rowsOf>> = {};
    for (const [key, read] of Object.entries(check.reads)) {
      sources[key] = rowsOf(`readiness read ${key}`, await reader(read));
    }
    findings.push(...checkFindings(check, check.evaluate(sources)));
  }
  return {
    answer: decideReadiness(coordination.revision, findings),
    coordination,
  };
};
