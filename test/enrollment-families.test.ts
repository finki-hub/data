import { describe, expect, test } from 'vitest';

import {
  familiesCheckScript,
  familiesScript,
} from '../src/flows/count-enrollments-scripts.js';
import {
  coordinateOperation,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import { familyRunnerFlow } from '../src/flows/run-enrollment-family.js';
import {
  legacyEnrollmentFlowIds,
  mappedEnrollmentFlowIds,
} from '../src/flows/shared.js';
import { refusalOf, runScript } from './legacy-enrollment-helpers.js';

// The Run Script bodies of "Data / Count enrollments" and the one runner
// every planned family goes through, "Data / Run enrollment family". The
// dispatcher's graph is in automatic-processing.test.ts.

const triggerClaim = '{{ $trigger.claim }}';
const claimToken = 'c0ffee00-0000-4000-8000-000000000001';

const stepOf =
  (flow: FlowTemplate) =>
  (key: string): OperationTemplate | undefined =>
    flow.operations.find((operation) => operation.key === key);

const keyIn =
  (flow: FlowTemplate) =>
  (id: null | string | undefined): string | undefined =>
    flow.operations.find((operation) => operation.id === id)?.key;

const runnerStep = stepOf(familyRunnerFlow);
const runnerKeyOf = keyIn(familyRunnerFlow);

// The keys along the resolve edges from the entry of a Flow.
const mainRow = (flow: FlowTemplate): string[] => {
  const order = [];
  let key = keyIn(flow)(flow.entry);
  while (key !== undefined) {
    order.push(key);
    key = keyIn(flow)(stepOf(flow)(key)?.resolve);
  }
  return order;
};

// An enrollments plan as plan_pages source enrollments answers it: the
// mapped family (two rule pages), then the legacy family (one history page
// crossed with one rule page, and its zero page).
const plan = {
  families: [
    {
      kind: 'mapped_entries',
      pages: [
        { from: 1, kind: 'mapped', rows: 3, to: 4, token: 'p0001' },
        { from: 9, kind: 'mapped', rows: 1, to: 9, token: 'p0002' },
      ],
      runnerFlowId: mappedEnrollmentFlowIds.pages,
    },
    {
      kind: 'legacy_regex',
      pages: [
        {
          bytes: 90,
          from: 1,
          kind: 'legacy',
          rows: 2,
          rules: { bytes: 40, from: 5, rows: 2, to: 8 },
          to: 2,
          token: 'p0003',
        },
        { from: 5, kind: 'legacy_zeros', rows: 2, to: 8, token: 'p0004' },
      ],
      runnerFlowId: legacyEnrollmentFlowIds.parent,
    },
  ],
  total: 4,
};

const familyPayloads = plan.families.map(({ kind, pages, runnerFlowId }) => ({
  claim: claimToken,
  kind,
  pages,
  revision: 11,
  runner: runnerFlowId,
}));

describe('the enrollment dispatcher scripts', () => {
  test('hands every planned family, with the claim and revision, to the family runner', () => {
    expect(
      runScript(familiesScript, {
        $trigger: { claim: claimToken, revision: 11 },
        plan,
      }),
    ).toEqual(familyPayloads);
    expect(
      runScript(familiesScript, {
        $trigger: { claim: claimToken, revision: 11 },
        plan: { families: [], total: 0 },
      }),
    ).toEqual([]);
    expect(
      refusalOf(() =>
        runScript(familiesScript, { $trigger: { claim: claimToken }, plan }),
      ),
    ).toContain('{claim, revision}');
    expect(
      refusalOf(() =>
        runScript(familiesScript, {
          $trigger: { claim: claimToken, revision: 11 },
          plan: { pages: [], total: 0 },
        }),
      ),
    ).toBe('plan_pages returned no family list; nothing was counted.');
    expect(
      refusalOf(() =>
        runScript(familiesScript, {
          $trigger: { claim: claimToken, revision: 11 },
          plan: {
            families: [{ ...plan.families[0], runnerFlowId: '{{ x }}' }],
            total: 2,
          },
        }),
      ),
    ).toBe(
      'Family 1 of the plan names no kind, runner Flow or page list; nothing was counted.',
    );
  });

  test('accepts the families only when each answered its own kind as counted', () => {
    const answers = [
      {
        kind: 'mapped_entries',
        ok: true,
        summary: { ok: true, pages: 2, staged: 4 },
      },
      {
        kind: 'legacy_regex',
        ok: true,
        summary: { legacyPages: 1, ok: true, zeroPages: 1 },
      },
    ];

    expect(
      runScript(familiesCheckScript, {
        families: familyPayloads,
        run_families: answers,
      }),
    ).toEqual({
      families: [
        { kind: 'mapped_entries', pages: 2, summary: answers[0]?.summary },
        { kind: 'legacy_regex', pages: 2, summary: answers[1]?.summary },
      ],
    });
    expect(
      refusalOf(() =>
        runScript(familiesCheckScript, {
          families: familyPayloads,
          run_families: [
            {
              code: 'LEGACY_COUNT_FAILED',
              message: 'Legacy page p0003 failed.',
              ok: false,
              stage: 'family',
            },
            answers[1],
          ],
        }),
      ),
    ).toBe(
      'Enrollment family mapped_entries failed (family: LEGACY_COUNT_FAILED Legacy page p0003 failed.); nothing was installed.',
    );

    // A runner that answered nothing, or another family's answer.
    for (const answer of [null, { ...answers[1], kind: 'mapped_entries' }]) {
      expect(
        refusalOf(() =>
          runScript(familiesCheckScript, {
            families: familyPayloads,
            run_families: [answers[0], answer],
          }),
        ),
      ).toBe(
        'Enrollment family legacy_regex failed (no valid answer); nothing was installed.',
      );
    }

    expect(
      refusalOf(() =>
        runScript(familiesCheckScript, {
          families: familyPayloads,
          run_families: [answers[0]],
        }),
      ),
    ).toContain('run_families answered 1 results for 2 families');
  });
});

describe('the family runner', () => {
  test('refreshes the claim, then runs the family through the runner Flow its plan names', () => {
    expect(familyRunnerFlow).toMatchObject({
      accountability: 'activity',
      id: '6a1d9f0e-2b3c-4d5e-8f70-000000001304',
      name: 'Data / Run enrollment family',
      options: { return: '$last' },
      trigger: 'operation',
    });
    expect(mainRow(familyRunnerFlow)).toEqual([
      'keep_alive',
      'run',
      'ran',
      'answer',
    ]);
    expect(runnerStep('keep_alive')?.options).toEqual({
      action: 'heartbeat',
      token: triggerClaim,
    });
    // The Trigger Flow target is templated from the family: verified on
    // the pinned 12.3.1 fixture (task-26 probe).
    expect(runnerStep('run')?.options).toEqual({
      flow: '{{ $trigger.runner }}',
      iterationMode: 'serial',
      payload: '{{ $trigger }}',
    });
    expect(runnerStep('ran')?.options).toEqual({
      filter: { run: { ok: { _eq: true } } },
    });
    expect(runnerStep('answer')?.options).toEqual({
      json: { kind: '{{ $trigger.kind }}', ok: true, summary: '{{ run }}' },
    });
  });

  test('relays a refused family and fails the claim itself only when the runner could not', () => {
    expect(runnerKeyOf(runnerStep('ran')?.reject)).toBe('refused');
    expect(runnerStep('refused')?.options).toEqual({
      filter: { run: { ok: { _eq: false } } },
    });

    const failures = {
      keep_alive: runnerStep(
        runnerKeyOf(runnerStep('keep_alive')?.reject) ?? '',
      ),
      refused: runnerStep(runnerKeyOf(runnerStep('refused')?.resolve) ?? ''),
      run: runnerStep(runnerKeyOf(runnerStep('run')?.reject) ?? ''),
      silent: runnerStep(runnerKeyOf(runnerStep('refused')?.reject) ?? ''),
    };

    for (const failure of Object.values(failures)) {
      expect(failure).toMatchObject({
        options: {
          action: 'fail',
          code: 'ENROLLMENTS_FAILED',
          token: triggerClaim,
        },
        type: coordinateOperation,
      });
      expect(
        runnerStep(runnerKeyOf(failure?.resolve) ?? '')?.options,
      ).toMatchObject({ json: { ok: false } });
    }

    expect(
      runnerStep(runnerKeyOf(failures.refused?.resolve) ?? '')?.options,
    ).toEqual({
      json: {
        code: '{{ run.code }}',
        message: '{{ run.stage }}: {{ run.code }} {{ run.message }}',
        ok: false,
        stage: 'family',
      },
    });
    expect(String(failures.silent?.options['message'])).toContain(
      '{{ $trigger.runner }} is inactive or deleted',
    );
  });
});
