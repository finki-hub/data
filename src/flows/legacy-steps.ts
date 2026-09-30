import { coordinateOperation } from './flow-template.js';
import { legacyFailureCode, legacyId, legacyStep as step } from './shared.js';
import { stepName } from './text-fragments.js';

// Helpers of the legacy Flows: the two child Flows (count-legacy-rule-page.ts
// and fill-legacy-zeros.ts) and their parent (count-legacy-enrollments.ts).

export const readStep = (collection: string, query: object) => ({
  collection,
  emitEvents: false,
  permissions: '$full',
  query,
});

// The context a child's failure record names: its page.
const pageContext = { page: '{{ $trigger.token }}' };

// One failure branch: the step whose rejection it takes (`source`), the
// suffixes of its fail step and failure record, the record key, the stage
// and the fixed code of a Run Script step (other steps answer their own).
type FailureBranch = {
  readonly code?: string;
  readonly fail: string;
  readonly key: string;
  readonly record: string;
  readonly source: string;
  readonly stage: string;
};

// The failure branches of a legacy Flow, in canvas order below the steps
// they serve, each record naming `context` (a child's page, nothing for
// the parent). Each first fails the claim (LEGACY_COUNT_FAILED): the
// candidates are discarded, the installed counts stay, and every later
// page of the parent's serial run refuses in check_page within
// milliseconds, before it reads a history or compiles a pattern, instead
// of running into the same timeout once per history page. The status keeps
// the refused step's message beside the code (ids only: the scripts never
// quote a pattern or a history). A claim that was failed already or
// replaced answers claim_mismatch there and is left as it is. The record
// then answers the failed step's own code and message.
export const failureSteps = (
  column: number,
  branches: readonly FailureBranch[],
  context: Readonly<Record<string, string>> = pageContext,
) =>
  branches.flatMap(({ code, fail, key, record, source, stage }, index) => [
    step({
      edges: { resolve: legacyId(record) },
      key: `${stage}_fail`,
      name: stepName.failClaim(stage),
      options: {
        action: 'fail',
        code: legacyFailureCode,
        message: `{{ ${source}.message }}`,
        token: '{{ $trigger.claim }}',
      },
      position: [column + 18 * index, 19],
      suffix: fail,
      type: coordinateOperation,
    }),
    step({
      key,
      name: stepName.answerFailure(stage),
      // The failure record of countFailure, naming the refused step: the
      // fail step ran in between, so $last is not that step any more.
      options: {
        json: {
          ...context,
          code: code ?? `{{ ${source}.code }}`,
          message: `{{ ${source}.message }}`,
          ok: false,
          stage,
        },
      },
      position: [column + 18 * index, 37],
      suffix: record,
      type: 'transform',
    }),
  ]);
