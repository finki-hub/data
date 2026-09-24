import assert from 'node:assert/strict';

import { graphSqlOf } from '../../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import { dispatcherFlow } from '../../src/flows/count-enrollments.js';
import { coordinateOperation } from '../../src/flows/flow-template.js';
import { familyRunnerFlow } from '../../src/flows/run-enrollment-family.js';
import {
  installFlow,
  operationOf,
  psql,
  removeFlow,
} from './automatic-processing-helpers.mjs';
import { get, trigger } from './history-index-helpers.mjs';

// Synthetic Flows, seeds and readers of the rule-mode fixture suite
// (rule-modes.integration.mjs). Every row is invented.

const collator = new Intl.Collator('en');

// graphSql's one binding, the coordinate operation type, as a literal.
const coordinateTypeTest = `o."type" = '${coordinateOperation}'`;

const flowIdOf = (suffix) => `9e4d826c-5b1a-4c0e-8f2d-0000000026${suffix}`;
const operationIdOf = (suffix) => `9e4d826c-5b1a-4c0e-8f2d-0000000027${suffix}`;

// The installed dispatcher and the runner every planned family goes
// through, children first.
export const dispatcherFlows = [familyRunnerFlow, dispatcherFlow];

export const courseNames = {
  alpha: 'Synthetic Mode Alpha',
  beta: 'Synthetic Mode Beta',
  gamma: 'Synthetic Mode Gamma',
};

export const yearLabels = { y1: '2081/2082', y2: '2082/2083' };

// The history line of a course and year: the literal entry a mapping names
// and the literal pattern a legacy rule tests, so both families count the
// same users.
export const lineOf = (course, year) =>
  `Synthetic Mode ${course[0].toUpperCase()}${course.slice(1)}-${yearLabels[year]}`;

export const seedHistories = [
  [lineOf('alpha', 'y1'), lineOf('beta', 'y1')].join('\n'),
  [lineOf('alpha', 'y1'), lineOf('alpha', 'y2')].join('\n'),
  [lineOf('beta', 'y2'), lineOf('gamma', 'y2')].join('\r\n'),
  'Synthetic Mode Unlisted',
];

// Four legacy rules (one of them a successful zero) and two mapped ones.
export const seedRules = [
  ['alpha', 'y1', 'legacy_regex'],
  ['beta', 'y1', 'legacy_regex'],
  ['gamma', 'y1', 'legacy_regex'],
  ['gamma', 'y2', 'legacy_regex'],
  ['alpha', 'y2', 'mapped_entries'],
  ['beta', 'y2', 'mapped_entries'],
];

// Every seeded line mapped to its own course and year, so converting a
// legacy rule to mapped_entries keeps its count.
export const seedMappings = [
  ['alpha', 'y1'],
  ['alpha', 'y2'],
  ['beta', 'y1'],
  ['beta', 'y2'],
  ['gamma', 'y2'],
];

export const expectedCounts = {
  'alpha/y1': 2,
  'alpha/y2': 1,
  'beta/y1': 1,
  'beta/y2': 1,
  'gamma/y1': 0,
  'gamma/y2': 1,
};

// The installed counts of the seeded pairs, keyed "course/year".
export const countsOf = async (target, state) => {
  const rows = await get(
    target,
    '/items/course_enrollments?fields=course,academic_year,count&limit=-1',
  );
  return Object.fromEntries(
    rows
      .map(({ academic_year, count, course }) => [
        `${state.courseKeys.get(course)}/${state.yearKeys.get(academic_year)}`,
        count,
      ])
      .toSorted(([left], [right]) => collator.compare(left, right)),
  );
};

// What the fingerprint and a Studio user see of an installed Flow: its
// trigger, options and entry, and each operation's key, type, options and
// edges.
export const liveFlow = async (target, id) => {
  const flow = await get(
    target,
    `/flows/${id}?fields=trigger,options,operation,status`,
  );
  const operations = await get(
    target,
    `/operations?fields=id,key,type,options,resolve,reject&filter[flow][_eq]=${id}&sort=id&limit=-1`,
  );
  return { ...flow, operations };
};

// The managed Flow graphs graphSql answers on the fixture for these
// runner roots (a test registry's), one row per operation: graph, Flow,
// operation and a digest of its options (the options hold `|`, psql's
// field separator). Read-only.
export const graphOnFixture = async (runners) => {
  const sql = graphSqlOf(runners).replace(
    'o."type" = ?',
    () => coordinateTypeTest,
  );
  const rows = await psql(
    `SELECT g."graph", g."flow", COALESCE(g."operation"::text, ''), md5(COALESCE(g."options"::text, '')) FROM (${sql}) AS g ORDER BY 1, 2, 3`,
  );
  return rows.map(([graph, flow, operation, digest]) => ({
    digest,
    flow,
    graph,
    operation,
  }));
};

const manual = (id, name) => ({
  accountability: 'activity',
  description: `${name}; removed by the rule-mode suite that installs it.`,
  icon: 'science',
  id,
  name,
  options: {
    async: false,
    collections: ['data_operations'],
    error_on_reject: true,
    requireSelection: false,
  },
  trigger: 'manual',
});

const child = (suffix, label) => ({
  accountability: 'activity',
  description: `Synthetic probe child ${label}; removed by the rule-mode suite that installs it.`,
  icon: 'science',
  id: flowIdOf(suffix),
  name: `Synthetic probe child ${label}`,
  options: { return: '$last' },
  trigger: 'operation',
});

// The probe of the templated Trigger Flow target (the verification gate of
// Task 26): two children, a runner whose target is templated from its
// trigger, a manual Flow whose target is templated from its body, and a
// manual dispatcher that runs a family list serially into the runner.
export const probeFlowIds = ['10', '20', '30', '40', '50'].map(flowIdOf);

const installProbe = async (target) => {
  for (const [suffix, label] of [
    ['10', 'C'],
    ['20', 'D'],
  ]) {
    await installFlow(target, child(suffix, label), [
      operationOf({
        id: operationIdOf(suffix),
        key: 'answer',
        options: { json: { child: label, got: '{{ $trigger }}' } },
        type: 'transform',
      }),
    ]);
  }
  await installFlow(
    target,
    { ...child('30', 'runner'), name: 'Synthetic probe runner' },
    [
      operationOf({
        id: operationIdOf('30'),
        key: 'run',
        options: {
          flow: '{{ $trigger.runner }}',
          iterationMode: 'serial',
          payload: '{{ $trigger.payload }}',
        },
        type: 'trigger',
      }),
    ],
  );
  await installFlow(target, manual(flowIdOf('40'), 'Synthetic probe direct'), [
    operationOf({
      id: operationIdOf('40'),
      key: 'run',
      options: {
        flow: '{{ $trigger.body.runner }}',
        iterationMode: 'serial',
        payload: '{{ $trigger.body.payload }}',
      },
      type: 'trigger',
    }),
  ]);
  await installFlow(
    target,
    manual(flowIdOf('50'), 'Synthetic probe dispatcher'),
    [
      operationOf({
        id: operationIdOf('50'),
        key: 'run',
        options: {
          flow: flowIdOf('30'),
          iterationMode: 'serial',
          payload: '{{ $trigger.body.families }}',
        },
        type: 'trigger',
      }),
    ],
  );
};

// Runs the probe and removes its Flows, whatever happened.
export const probeTemplatedTarget = async (target) => {
  try {
    await installProbe(target);
    const direct = await trigger(target, `/flows/trigger/${flowIdOf('40')}`, {
      collection: 'data_operations',
      payload: { page: 1 },
      runner: flowIdOf('10'),
    });
    const nested = await trigger(target, `/flows/trigger/${flowIdOf('50')}`, {
      collection: 'data_operations',
      families: [
        { payload: { family: 'first' }, runner: flowIdOf('10') },
        { payload: { family: 'second' }, runner: flowIdOf('20') },
        { payload: { family: 'unknown' }, runner: flowIdOf('99') },
      ],
    });
    return { direct, nested };
  } finally {
    for (const id of probeFlowIds.toReversed()) await removeFlow(target, id);
  }
};

export const probeChild = (label, got) => ({ child: label, got });

export const probeChildIds = { c: flowIdOf('10'), d: flowIdOf('20') };

// The flows of one graph among these rows.
export const flowsIn = (rows, graph) =>
  new Set(rows.filter((row) => row.graph === graph).map(({ flow }) => flow));

// The rows of the given Flows, as the graph holds them.
export const rowsOfFlows = (rows, ids) =>
  rows.filter(({ flow }) => ids.includes(flow));

export const assertAnswered = (outcome) => {
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  return outcome.body;
};
