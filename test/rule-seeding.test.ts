import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { ruleMode } from '../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import {
  pairsScript,
  ruleBatchSize,
  scopeScript,
  tallyScript,
} from '../src/flows/add-enrollment-rules-scripts.js';
import {
  ruleSeedingBatchFlow,
  ruleSeedingBatchFlowId,
} from '../src/flows/add-enrollment-rules-steps.js';
import {
  enrollmentRuleFlows,
  ruleSeedingFlow,
  ruleSeedingFlowId,
} from '../src/flows/add-enrollment-rules.js';
import {
  flowFamilyCodes,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import { flowFamily } from '../src/flows/registry.js';
import { refusalOf, runScript } from './flow-script-helpers.js';

// "Data / Add enrollment rules" (Task 16, owner decision 2026-09-23): the
// explicit, idempotent seeding of mapped_entries rules for a new academic
// year or course. The template and its scripts, run in node:vm the way Run
// Script runs them; the fixture scenario operations.integration.mjs runs
// the installed Flow.

const mappedMode = ruleMode('mapped_entries').mode;

const stepOf = (flow: FlowTemplate, key: string): OperationTemplate => {
  const found = flow.operations.find((operation) => operation.key === key);
  if (found === undefined) {
    throw new Error(`${flow.name} has no step ${key}`);
  }
  return found;
};

const keyOf = (flow: FlowTemplate, id: null | string): null | string =>
  flow.operations.find((operation) => operation.id === id)?.key ?? null;

// The keys along the resolve edges from the entry.
const mainRow = (flow: FlowTemplate): string[] => {
  const keys: string[] = [];
  let id: null | string = flow.entry;
  while (id !== null) {
    const current: OperationTemplate = stepOf(flow, keyOf(flow, id) ?? '');
    keys.push(current.key);
    id = current.resolve;
  }
  return keys;
};

const writeTypes = new Set(['item-create', 'item-delete', 'item-update']);

const isWrite = ({ type }: OperationTemplate): boolean => writeTypes.has(type);

const scopeSchema = z.object({
  course: z.number().nullable(),
  courses: z.unknown(),
  rules: z.object({ _and: z.array(z.unknown()) }),
  year: z.number().nullable(),
  years: z.unknown(),
});

const pairsSchema = z.object({
  batches: z.array(
    z.array(
      z.object({
        academic_year: z.number(),
        course: z.number(),
        mode: z.string(),
      }),
    ),
  ),
  courses: z.number(),
  existing: z.number(),
  missing: z.number(),
  years: z.number(),
});

const scope = (body: unknown) =>
  scopeSchema.parse(runScript(scopeScript, { $trigger: { body } }));

const ids = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => ({ id: from + index }));

const pairs = (data: Record<string, unknown>) =>
  pairsSchema.parse(runScript(pairsScript, data));

describe('Data / Add enrollment rules', () => {
  test('is a registered manual Flow family whose batch child installs first', () => {
    expect(flowFamily(flowFamilyCodes.rules).templates).toBe(
      enrollmentRuleFlows,
    );
    expect(enrollmentRuleFlows.map(({ id }) => id)).toEqual([
      ruleSeedingBatchFlowId,
      ruleSeedingFlowId,
    ]);
    expect(ruleSeedingFlow.trigger).toBe('manual');
    expect(ruleSeedingFlow.accountability).toBe('activity');
    expect(ruleSeedingFlow.options).toMatchObject({
      async: false,
      collections: ['data_operations'],
      error_on_reject: true,
      requireConfirmation: true,
      requireSelection: false,
    });
    expect(ruleSeedingBatchFlow).toMatchObject({
      options: { return: '$last' },
      trigger: 'operation',
    });
  });

  test('resolves the scope before anything is read or written', () => {
    const resolve = stepOf(ruleSeedingFlow, 'scope');

    expect(ruleSeedingFlow.entry).toBe(resolve.id);
    expect(resolve.type).toBe('exec');
    expect(keyOf(ruleSeedingFlow, resolve.reject)).toBe('raise_scope');
    expect(mainRow(ruleSeedingFlow)).toEqual([
      'scope',
      'years',
      'courses',
      'rules',
      'pairs',
      'create_batches',
      'tally',
      'answer',
    ]);
  });

  test('reads natively, creates through serial batches and never touches a mapping', () => {
    const reads = ruleSeedingFlow.operations.filter(
      ({ type }) => type === 'item-read',
    );
    const loop = stepOf(ruleSeedingFlow, 'create_batches');
    const create = stepOf(ruleSeedingBatchFlow, 'create');

    expect(reads.map(({ options }) => options['collection'])).toEqual([
      'academic_years',
      'courses',
      'course_enrollment_rules',
    ]);
    expect(loop.options).toEqual({
      flow: ruleSeedingBatchFlowId,
      iterationMode: 'serial',
      payload: '{{ pairs.batches }}',
    });
    expect(create).toMatchObject({
      options: {
        collection: 'course_enrollment_rules',
        emitEvents: false,
        payload: '{{ $trigger }}',
        permissions: '$trigger',
      },
      type: 'item-create',
    });

    const writes = enrollmentRuleFlows.flatMap(({ operations }) =>
      operations.filter(isWrite),
    );

    expect(writes).toEqual([create]);
    expect(JSON.stringify(enrollmentRuleFlows)).not.toContain(
      'moodle_course_mappings',
    );
  });

  test('offers the year and the course through Studio item pickers', () => {
    const { fields } = z
      .object({
        fields: z.array(
          z.object({
            field: z.string(),
            meta: z.object({
              interface: z.string(),
              options: z.object({ selectedCollection: z.string() }),
            }),
          }),
        ),
      })
      .parse(ruleSeedingFlow.options);

    expect(
      fields.map(({ field, meta }) => [
        field,
        meta.interface,
        meta.options.selectedCollection,
      ]),
    ).toEqual([
      ['academic_year', 'collection-item-dropdown', 'academic_years'],
      ['course', 'collection-item-dropdown', 'courses'],
    ]);
  });
});

describe('the scripts of Data / Add enrollment rules', () => {
  test('reads the scope from a pick, a plain id or both, and refuses anything else', () => {
    expect(
      scope({ academic_year: { collection: 'academic_years', key: 7 } }),
    ).toEqual({
      course: null,
      courses: { id: { _nnull: true } },
      rules: { _and: [{ academic_year: { _eq: 7 } }] },
      year: 7,
      years: { id: { _eq: 7 } },
    });
    expect(scope({ course: '12' })).toMatchObject({
      course: 12,
      rules: { _and: [{ course: { _eq: 12 } }] },
      year: null,
      years: { id: { _nnull: true } },
    });
    expect(scope({ academic_year: 3, course: { key: 4 } }).rules).toEqual({
      _and: [{ academic_year: { _eq: 3 } }, { course: { _eq: 4 } }],
    });
    expect(
      refusalOf(() => runScript(scopeScript, { $trigger: { body: {} } })),
    ).toBe('Scope missing: expected academic year, course or both');
    expect(
      refusalOf(() =>
        runScript(scopeScript, {
          $trigger: {
            body: { course: { collection: 'academic_years', key: 1 } },
          },
        }),
      ),
    ).toBe('Course: collection academic_years, expected courses');
    expect(
      refusalOf(() =>
        runScript(scopeScript, {
          $trigger: { body: { academic_year: '1 OR 1' } },
        }),
      ),
    ).toBe('Academic year: expected an id of academic_years');
  });

  test('creates only the missing pairs, in the declared mapped mode, in batches of at most 250', () => {
    const answer = pairs({
      courses: ids(600),
      rules: [
        { academic_year: 1, course: 5 },
        { academic_year: 1, course: 6 },
      ],
      scope: { course: null, year: 1 },
      years: [{ id: 1 }],
    });

    expect(ruleBatchSize).toBe(250);
    expect(answer).toMatchObject({
      courses: 600,
      existing: 2,
      missing: 598,
      years: 1,
    });
    expect(answer.batches.map((batch) => batch.length)).toEqual([250, 250, 98]);

    const created = answer.batches.flat();

    expect(new Set(created.map(({ mode }) => mode))).toEqual(
      new Set([mappedMode]),
    );
    expect(created.some(({ course }) => course === 5 || course === 6)).toBe(
      false,
    );
  });

  test('skips an existing rule of any mode, so a rerun creates nothing', () => {
    const first = pairs({
      courses: [{ id: 9 }],
      rules: [{ academic_year: 2, course: 9 }],
      scope: { course: 9, year: null },
      years: ids(3),
    });

    expect(first.batches.flat()).toEqual([
      { academic_year: 1, course: 9, mode: mappedMode },
      { academic_year: 3, course: 9, mode: mappedMode },
    ]);

    const rerun = pairs({
      courses: [{ id: 9 }],
      rules: ids(3).map(({ id }) => ({ academic_year: id, course: 9 })),
      scope: { course: 9, year: null },
      years: ids(3),
    });

    expect(rerun).toMatchObject({ batches: [], existing: 3, missing: 0 });
  });

  test('refuses a named year or course that does not exist', () => {
    expect(
      refusalOf(() =>
        runScript(pairsScript, {
          courses: ids(2),
          rules: [],
          scope: { course: null, year: 99 },
          years: [],
        }),
      ),
    ).toBe('Academic year 99 not found');
    expect(
      refusalOf(() =>
        runScript(pairsScript, {
          courses: [],
          rules: [],
          scope: { course: 5, year: null },
          years: ids(1),
        }),
      ),
    ).toBe('Course 5 not found');
  });

  test('tallies the created rules and refuses a failed batch without pretending success', () => {
    const batches = [[{}, {}], [{}]];

    expect(
      runScript(tallyScript, {
        create_batches: [
          { created: [1, 2], ok: true },
          { created: [3], ok: true },
        ],
        pairs: { batches },
      }),
    ).toEqual({ batches: 2, created: 3 });
    expect(
      refusalOf(() =>
        runScript(tallyScript, {
          create_batches: [
            { created: [1, 2], ok: true },
            { code: 'RECORD_NOT_UNIQUE', ok: false },
          ],
          pairs: { batches },
        }),
      ),
    ).toBe('Batches failed: 2/2 (RECORD_NOT_UNIQUE, 1 rule); rules created: 2');
    expect(
      refusalOf(() =>
        runScript(tallyScript, {
          create_batches: [{ code: 'RECORD_NOT_UNIQUE', ok: false }, null],
          pairs: {
            batches: [
              [{}, {}],
              [{}, {}],
            ],
          },
        }),
      ),
    ).toBe(
      'Batches failed: 1/2 (RECORD_NOT_UNIQUE, 2 rules), 2/2 (NO_ANSWER, 2 rules); rules created: 0',
    );
  });
});
