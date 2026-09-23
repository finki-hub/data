import type { SourceReader } from './engine.js';
import type { ReadinessEntry } from './readiness-types.js';
import type { IssueCounts } from './types.js';

import {
  type CoordinationFacts,
  snapshotCounts,
  type SnapshotFacts,
  statusCounts,
} from './readiness-facts.js';
import { readinessRegistry } from './readiness-registry.js';
import { registryCounts, sharedReader } from './readiness-run.js';

// Whether the public files can be prepared exactly at the current source
// revision, decided from the readiness-check registry alone: every entry
// is counted, `issueCounts` holds every registered code, and `ready` is
// true exactly when every blocker counts zero. The answer holds codes,
// counts, Studio pages and bookmark names only, never a name, a label or a
// record.

export type ReadinessAnswer = {
  // The public files the positive blockers hold back.
  readonly blockedFiles: readonly string[];
  readonly blockers: readonly string[];
  readonly issueCounts: IssueCounts;
  // The Studio page of every positive code.
  readonly links: Readonly<Record<string, string>>;
  readonly ready: boolean;
  // The Needs review bookmark of every positive code that declares one.
  readonly reviews: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly warnings: readonly string[];
};

export type ReadinessDeps = {
  readonly coordination: () => Promise<CoordinationFacts>;
  readonly reader: SourceReader;
  readonly snapshot: () => Promise<SnapshotFacts>;
};

// The answer over the counts of every entry, blockers and warnings each in
// registry order.
export const decideReadiness = (
  revision: number,
  counts: ReadonlyMap<string, number>,
  registry: readonly ReadinessEntry[] = readinessRegistry,
): ReadinessAnswer => {
  const positive = registry.filter(({ code }) => (counts.get(code) ?? 0) > 0);
  const blocking = positive.filter(({ severity }) => severity === 'blocker');
  return {
    blockedFiles: [...new Set(blocking.flatMap(({ gates }) => gates))],
    blockers: blocking.map(({ code }) => code),
    issueCounts: Object.fromEntries(
      registry.map(({ code }) => [code, counts.get(code) ?? 0]),
    ),
    links: Object.fromEntries(
      positive.map(({ code, page }) => [code, `/admin/content/${page}`]),
    ),
    ready: blocking.length === 0,
    reviews: Object.fromEntries(
      positive.flatMap(({ code, review }) =>
        review === undefined ? [] : [[code, review.bookmark]],
      ),
    ),
    revision,
    warnings: positive
      .filter(({ severity }) => severity === 'warning')
      .map(({ code }) => code),
  };
};

// Reads the coordinator and snapshot facts first, then counts every
// registry entry through one reader (a read two checks share is made
// once); answers the decision and the facts it was taken at.
export const assessReadiness = async (
  deps: ReadinessDeps,
  registry: readonly ReadinessEntry[] = readinessRegistry,
): Promise<{
  readonly answer: ReadinessAnswer;
  readonly coordination: CoordinationFacts;
}> => {
  const coordination = await deps.coordination();
  const facts = {
    snapshot: snapshotCounts(await deps.snapshot()),
    status: statusCounts(coordination),
  };
  const counts = await registryCounts(
    registry,
    facts,
    sharedReader(deps.reader),
  );
  return {
    answer: decideReadiness(coordination.revision, counts, registry),
    coordination,
  };
};
