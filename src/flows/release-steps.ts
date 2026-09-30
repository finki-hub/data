import {
  coordinateOperation,
  familyId,
  type FlowFamilyCode,
  operation,
  type OperationTemplate,
} from './flow-template.js';
import { stepName } from './text-fragments.js';

// One failure branch of a claim-bound Flow: the step whose rejection it
// takes fails the claim, then the branch answers a failure record.
export type ReleaseBranch = {
  // The code kept with the claim's failure (a fixed, bounded code).
  readonly code: string;
  // The Flow family the branch belongs to.
  readonly family: FlowFamilyCode;
  // The (templated) message kept beside the code and answered.
  readonly message: string;
  // Where the fail step sits on the canvas; its record sits below it.
  readonly position: readonly [number, number];
  // The code the record answers, for example the refused step's own code;
  // the stored code when absent.
  readonly recordCode?: string;
  // The stage the record answers, for example a child's own stage when the
  // branch forwards the child's failure record; the branch stage when
  // absent.
  readonly recordStage?: string;
  readonly stage: string;
  // Suffixes of the fail step and of the record after it.
  readonly suffixes: readonly [string, string];
  // The claim token, templated.
  readonly token: string;
};

// The fail step of a branch, for the reject edge of the step it serves.
export const failStepId = (branch: ReleaseBranch): string =>
  familyId(branch.family, branch.suffixes[0]);

// A branch fails the claim first, so its candidates are discarded, the
// installed rows stay, and the status keeps the code and the bounded
// message (the only trace of a scheduled run, which has no caller). A
// claim already released (an overtaking, or a child that failed it)
// answers claim_mismatch there and keeps the release it had. The branch
// then answers {ok: false, stage, code, message}, the uniform failure
// record of the automatic processing Flows.
export const releaseSteps = (branch: ReleaseBranch): OperationTemplate[] => [
  operation({
    edges: { resolve: familyId(branch.family, branch.suffixes[1]) },
    family: branch.family,
    key: `${branch.stage}_fail`,
    name: stepName.failClaim(branch.stage),
    options: {
      action: 'fail',
      code: branch.code,
      message: branch.message,
      token: branch.token,
    },
    position: branch.position,
    suffix: branch.suffixes[0],
    type: coordinateOperation,
  }),
  operation({
    family: branch.family,
    key: `${branch.stage}_failed`,
    name: stepName.answerFailure(branch.stage),
    options: {
      json: {
        code: branch.recordCode ?? branch.code,
        message: branch.message,
        ok: false,
        stage: branch.recordStage ?? branch.stage,
      },
    },
    position: [branch.position[0], branch.position[1] + 18],
    suffix: branch.suffixes[1],
    type: 'transform',
  }),
];

// A step of a claim-bound Flow's main row: it resolves into the next step
// of its family and rejects into its failure branch.
export const chainStep = (spec: {
  readonly column: number;
  readonly failure: ReleaseBranch;
  readonly key: string;
  readonly name: string;
  readonly next: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly suffix: string;
  readonly type: string;
}): OperationTemplate =>
  operation({
    edges: {
      reject: failStepId(spec.failure),
      resolve: familyId(spec.failure.family, spec.next),
    },
    family: spec.failure.family,
    key: spec.key,
    name: spec.name,
    options: spec.options,
    position: [spec.column, 1],
    suffix: spec.suffix,
    type: spec.type,
  });
