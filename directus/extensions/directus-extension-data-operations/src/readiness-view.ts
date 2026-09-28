import type { ReadinessEntry } from './exports/readiness-types.js';
import type { ReadinessAnswer } from './exports/readiness.js';
import type { Audience, ReadinessView } from './status-contract.js';

import { readinessRegistry } from './exports/readiness-registry.js';
import { bookmarkPage, collectionPage } from './managed-flows.js';
import { bookmarkKey } from './status-reads.js';

// Readiness as the dashboard shows it: one row per declared check of the
// readiness-check registry, in registry order, with its severity, count,
// description, the files it gates and one Studio link to the records
// behind it (its Needs review bookmark when it declares one and setup
// installed it, else its collection page). Counts and links only.

// The bookmark names the registry declares, for the bookmark lookup.
export const reviewBookmarks = (
  registry: readonly ReadinessEntry[] = readinessRegistry,
): string[] => [
  ...new Set(
    registry.flatMap(({ review }) =>
      review === undefined ? [] : [review.bookmark],
    ),
  ),
];

type ReadinessInputs = {
  readonly answer: ReadinessAnswer;
  readonly audience: Audience;
  // The installed review bookmarks, by bookmarkKey(collection, name).
  readonly bookmarks: ReadonlyMap<string, number>;
  readonly registry?: readonly ReadinessEntry[];
};

export const readinessView = ({
  answer,
  audience,
  bookmarks,
  registry = readinessRegistry,
}: ReadinessInputs): ReadinessView => ({
  audience,
  blockedFiles: [...answer.blockedFiles],
  checks: registry.map(
    ({ code, description, gates, page, review, severity }) => {
      const bookmark =
        review === undefined
          ? undefined
          : bookmarks.get(bookmarkKey(page, review.bookmark));
      return {
        code,
        count: answer.issueCounts[code] ?? 0,
        description,
        gates: [...gates],
        link:
          bookmark === undefined
            ? collectionPage(page)
            : bookmarkPage(page, bookmark),
        page,
        review: review?.bookmark ?? null,
        severity,
      };
    },
  ),
  ready: answer.ready,
  revision: answer.revision,
});
