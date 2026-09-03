import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const publicCollections = ['courses', 'rooms', 'staff', 'students'] as const;

type DirectusRequest = (
  pathname: string,
  init?: Parameters<typeof fetch>[1],
) => Promise<unknown>;

type OperationIds = {
  readonly publish: string;
  readonly readCourses: string;
  readonly readRooms: string;
  readonly readStaff: string;
  readonly readStudents: string;
  readonly serialize: string;
};

const createOperationIds = (): OperationIds => ({
  publish: randomUUID(),
  readCourses: randomUUID(),
  readRooms: randomUUID(),
  readStaff: randomUUID(),
  readStudents: randomUUID(),
  serialize: randomUUID(),
});

const createReadOperations = (ids: OperationIds) =>
  [
    {
      collection: 'courses',
      id: ids.readCourses,
      name: 'Read courses',
      resolve: ids.readRooms,
    },
    {
      collection: 'rooms',
      id: ids.readRooms,
      name: 'Read rooms',
      resolve: ids.readStaff,
    },
    {
      collection: 'staff',
      id: ids.readStaff,
      name: 'Read staff',
      resolve: ids.readStudents,
    },
    {
      collection: 'students',
      id: ids.readStudents,
      name: 'Read students',
      resolve: ids.serialize,
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
    resolve,
    type: 'item-read',
  }));

const createOperations = (ids: OperationIds, serializer: string) => [
  ...createReadOperations(ids),
  {
    id: ids.serialize,
    key: 'serialize_assets',
    name: 'Serialize public assets',
    options: { code: serializer },
    position_x: 91,
    resolve: ids.publish,
    type: 'exec',
  },
  {
    id: ids.publish,
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
    resolve: null,
    type: 'finki-hub-publish-json',
  },
];

export const createPublicAssetsFlow = async (
  request: DirectusRequest,
): Promise<void> => {
  const flowId = randomUUID();
  const operationIds = createOperationIds();
  const serializer = await readFile(
    'directus/flows/serialize-assets.cjs',
    'utf8',
  );

  await request('/flows', {
    body: JSON.stringify({
      accountability: 'activity',
      description:
        'Publishes courses.json, rooms.json, staff.json, and students.json.',
      icon: 'cloud_upload',
      id: flowId,
      name: 'Publish public assets',
      options: {
        async: false,
        collections: publicCollections,
        location: 'collection',
        requireConfirmation: true,
        requireSelection: false,
      },
      status: 'inactive',
      trigger: 'manual',
    }),
    method: 'POST',
  });

  for (const operation of createOperations(
    operationIds,
    serializer,
  ).toReversed()) {
    await request('/operations', {
      body: JSON.stringify({ ...operation, flow: flowId, position_y: 1 }),
      method: 'POST',
    });
  }

  await request(`/flows/${flowId}`, {
    body: JSON.stringify({
      operation: operationIds.readCourses,
      status: 'active',
    }),
    method: 'PATCH',
  });
};
