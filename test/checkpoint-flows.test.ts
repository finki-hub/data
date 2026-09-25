import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import {
  derivedDataFlow,
  derivedDataFlowId,
} from '../src/derived-data-flow.js';
import {
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import { flowTemplates } from '../src/flows/registry.js';
import { validateReadinessFlow } from '../src/flows/validate-readiness.js';
import {
  loadPublicAssetsFlow,
  publicAssetsFlow,
  publicAssetsFlowId,
} from '../src/public-assets-flow.js';

// The two checkpoint Flows the one-time workbook import installs start with
// the Administrator? gate of every managed manual Flow; everything else is
// pinned to what they held before the gate was added.

const checkpointPrefix = '6a1d9f0e-2b3c-4d5e-8f70-0000000007';
const id = (suffix: string): string => `${checkpointPrefix}${suffix}`;
const serializer = 'module.exports = () => ({});';
const fullRead = { fields: ['*'], limit: -1, sort: ['id'] };

// The operations, entry and options each Flow held before the gate.
const formerRebuild = {
  entry: id('11'),
  operations: [
    {
      id: id('11'),
      key: 'rebuild_derived_data',
      name: 'Rebuild derived data',
      options: {},
      position_x: 19,
      position_y: 1,
      reject: null,
      resolve: null,
      type: 'finki-hub-rebuild-derived-data',
    },
  ],
  options: {
    async: false,
    collections: [
      'courses',
      'course_enrollment_patterns',
      'curriculum_2023',
      'curriculum_2018',
      'course_equivalencies',
      'teaching_assignments',
      'moodle_users',
      'students',
      'student_council',
    ],
    location: 'collection',
    requireConfirmation: true,
    requireSelection: false,
  },
};

const formerRead = (
  collection: string,
  name: string,
  [suffix, next, column]: readonly [string, string, number],
) => ({
  id: id(suffix),
  key: `read_${collection}`,
  name,
  options: {
    collection,
    emitEvents: false,
    permissions: '$full',
    query: fullRead,
  },
  position_x: column,
  position_y: 1,
  reject: null,
  resolve: id(next),
  type: 'item-read',
});

const formerPublish = {
  entry: id('21'),
  operations: [
    formerRead('courses', 'Read courses', ['21', '22', 19]),
    formerRead('rooms', 'Read rooms', ['22', '23', 37]),
    formerRead('staff', 'Read staff', ['23', '24', 55]),
    formerRead('students', 'Read students', ['24', '25', 73]),
    {
      id: id('25'),
      key: 'serialize_assets',
      name: 'Serialize public assets',
      options: { code: serializer },
      position_x: 91,
      position_y: 1,
      reject: null,
      resolve: id('26'),
      type: 'exec',
    },
    {
      id: id('26'),
      key: 'publish_assets',
      name: 'Publish JSON files',
      options: {
        objects: {
          'courses.json': '{{serialize_assets.courses}}',
          'rooms.json': '{{serialize_assets.rooms}}',
          'staff.json': '{{serialize_assets.staff}}',
          'students.json': '{{serialize_assets.students}}',
        },
        storage: 'publish',
      },
      position_x: 109,
      position_y: 1,
      reject: null,
      resolve: null,
      type: 'finki-hub-publish-json',
    },
  ],
  options: {
    async: false,
    collections: ['courses', 'rooms', 'staff', 'students'],
    location: 'collection',
    requireConfirmation: true,
    requireSelection: false,
  },
};

// Every id of the Flows setup installs.
const managedIds = new Set(
  flowTemplates().flatMap((flow) => [
    flow.id,
    ...flow.operations.map((operation) => operation.id),
  ]),
);

const stepOf = (
  flow: FlowTemplate,
  stepId: null | string,
): OperationTemplate => {
  const found = flow.operations.find((operation) => operation.id === stepId);
  if (found === undefined) {
    throw new Error(`${flow.name} has no operation ${String(stepId)}`);
  }
  return found;
};

const keyed = (flow: FlowTemplate, key: string): OperationTemplate => {
  const found = flow.operations.find((operation) => operation.key === key);
  if (found === undefined) {
    throw new Error(`${flow.name} has no ${key}`);
  }
  return found;
};

// What a gate or refusal shares with the managed Flows' own: everything
// but its id, edges, position and message.
const shape = ({ key, name, options, type }: OperationTemplate) => ({
  filter: options['filter'],
  key,
  name,
  status: options['status'],
  type,
});

describe.each([
  {
    flow: derivedDataFlow,
    former: formerRebuild,
    gate: ['12', '13'],
    message: 'Only administrators may rebuild the derived data.',
    name: 'Rebuild derived data',
    stableId: derivedDataFlowId,
    suffix: '01',
  },
  {
    flow: publicAssetsFlow(serializer),
    former: formerPublish,
    gate: ['27', '28'],
    message: 'Only administrators may publish the public files.',
    name: 'Publish public assets',
    stableId: publicAssetsFlowId,
    suffix: '02',
  },
] as const)(
  'the checkpoint $name Flow',
  ({ flow, former, gate, message, name, stableId, suffix }) => {
    test('starts with the Administrator? gate, which refuses with 403 and resolves into the former entry', () => {
      const entry = stepOf(flow, flow.entry);
      const refusal = stepOf(flow, entry.reject);

      expect(flow.entry).toBe(id(gate[0]));
      expect(entry).toMatchObject({
        key: 'admin_only',
        options: { filter: { $accountability: { admin: { _eq: true } } } },
        resolve: former.entry,
        type: 'condition',
      });
      expect(refusal).toMatchObject({
        id: id(gate[1]),
        options: { code: 'FORBIDDEN', message, status: 403 },
        reject: null,
        resolve: null,
        type: 'throw-error',
      });
      // A throw-error answers its status only with error_on_reject on a
      // synchronous manual Flow; otherwise the trigger answers 200.
      expect(flow.options).toMatchObject({
        async: false,
        error_on_reject: true,
      });
    });

    test('uses the same gate as every managed manual Flow', () => {
      const managed = validateReadinessFlow;

      expect(shape(keyed(flow, 'admin_only'))).toEqual(
        shape(keyed(managed, 'admin_only')),
      );
      expect(shape(keyed(flow, 'raise_forbidden'))).toEqual(
        shape(keyed(managed, 'raise_forbidden')),
      );
    });

    test('keeps every other operation, the options, the id and the name as they were', () => {
      const gateIds = new Set(gate.map((part) => id(part)));
      const others = flow.operations.filter(
        (operation) => !gateIds.has(operation.id),
      );

      expect(flow.operations).toHaveLength(former.operations.length + 2);
      expect(JSON.stringify(others)).toBe(JSON.stringify(former.operations));
      expect(flow.options).toEqual({
        ...former.options,
        error_on_reject: true,
      });
      expect(flow).toMatchObject({
        accountability: 'activity',
        id: stableId,
        name,
        trigger: 'manual',
      });
    });

    test('keeps stable ids of its own and a free place for every step', () => {
      const ids = [
        flow.id,
        ...flow.operations.map((operation) => operation.id),
      ];
      const places = flow.operations.map(
        ({ position_x, position_y }) =>
          `${String(position_x)},${String(position_y)}`,
      );

      expect(stableId).toBe(id(suffix));
      expect(
        ids.every((each) => each.startsWith(checkpointPrefix)),
      ).toBeTruthy();
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((each) => managedIds.has(each))).toEqual([]);
      expect(new Set(places).size).toBe(places.length);
    });
  },
);

describe('the loaded Publish public assets template', () => {
  test('carries the repository reference serializer unchanged', async () => {
    const reference = await readFile(
      'directus/flows/serialize-assets.cjs',
      'utf8',
    );

    await expect(loadPublicAssetsFlow()).resolves.toEqual(
      publicAssetsFlow(reference),
    );
  });
});
