import { readFile } from 'node:fs/promises';

import {
  checkpointFamilyCode,
  checkpointFlowId,
  type FlowTemplate,
  type OperationTemplate,
} from './flows/flow-template.js';
import { adminOnly } from './flows/validate-readiness.js';

const publicCollections = ['courses', 'rooms', 'staff', 'students'] as const;

export const publicAssetsFlowId = checkpointFlowId('02');

const operationIds = {
  publish: checkpointFlowId('26'),
  readCourses: checkpointFlowId('21'),
  readRooms: checkpointFlowId('22'),
  readStaff: checkpointFlowId('23'),
  readStudents: checkpointFlowId('24'),
  serialize: checkpointFlowId('25'),
} as const;

// The Administrator? gate, its refusal and the first read it lets through.
// The gate sits below the first read, so every step keeps its place.
const gate = ['27', '28', '21'] as const;

const readOperations: readonly OperationTemplate[] = [
  {
    collection: 'courses',
    id: operationIds.readCourses,
    name: 'Read courses',
    resolve: operationIds.readRooms,
  },
  {
    collection: 'rooms',
    id: operationIds.readRooms,
    name: 'Read rooms',
    resolve: operationIds.readStaff,
  },
  {
    collection: 'staff',
    id: operationIds.readStaff,
    name: 'Read staff',
    resolve: operationIds.readStudents,
  },
  {
    collection: 'students',
    id: operationIds.readStudents,
    name: 'Read students',
    resolve: operationIds.serialize,
  },
].map(({ collection, id, name, resolve }, index) => ({
  id,
  key: `read_${collection}`,
  name,
  options: {
    collection,
    emitEvents: false,
    permissions: '$full',
    query: { fields: ['*'], limit: -1, sort: ['id'] },
  },
  position_x: 19 + index * 18,
  position_y: 1,
  reject: null,
  resolve,
  type: 'item-read',
}));

// The checkpoint Publish public assets Flow under stable ids: the
// Administrator? gate every managed manual Flow starts with (anyone who
// may read one of its collections passes the trigger endpoint, and the
// reads run with full rights), native reads of the four public
// collections, the editable serializer, then the narrow storage writer.
// Installed once by the workbook import; Studio owns it afterwards.
export const publicAssetsFlow = (serializer: string): FlowTemplate => ({
  accountability: 'activity',
  description:
    'Publishes courses.json, rooms.json, staff.json, and students.json (administrators only).',
  entry: checkpointFlowId(gate[0]),
  icon: 'cloud_upload',
  id: publicAssetsFlowId,
  name: 'Publish public assets',
  operations: [
    ...adminOnly(gate, 'Only administrators may publish the public files.', {
      at: [19, 19],
      code: checkpointFamilyCode,
    }),
    ...readOperations,
    {
      id: operationIds.serialize,
      key: 'serialize_assets',
      name: 'Serialize public assets',
      options: { code: serializer },
      position_x: 91,
      position_y: 1,
      reject: null,
      resolve: operationIds.publish,
      type: 'exec',
    },
    {
      id: operationIds.publish,
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
    collections: publicCollections,
    error_on_reject: true,
    location: 'collection',
    requireConfirmation: true,
    requireSelection: false,
  },
  trigger: 'manual',
});

// The template with the repository's reference serializer as its script.
export const loadPublicAssetsFlow = async (): Promise<FlowTemplate> =>
  publicAssetsFlow(
    await readFile('directus/flows/serialize-assets.cjs', 'utf8'),
  );
