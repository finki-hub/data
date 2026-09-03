import { randomUUID } from 'node:crypto';

const sourceCollections = [
  'courses',
  'course_enrollment_patterns',
  'curriculum_2023',
  'curriculum_2018',
  'course_equivalencies',
  'teaching_assignments',
  'moodle_users',
  'students',
  'student_council',
] as const;

type DirectusRequest = (
  pathname: string,
  init?: Parameters<typeof fetch>[1],
) => Promise<unknown>;

export const createDerivedDataFlow = async (
  request: DirectusRequest,
): Promise<string> => {
  const flowId = randomUUID();
  const operationId = randomUUID();

  await request('/flows', {
    body: JSON.stringify({
      accountability: 'activity',
      description:
        'Recalculates course exports and student council names from source collections.',
      icon: 'calculate',
      id: flowId,
      name: 'Rebuild derived data',
      options: {
        async: false,
        collections: sourceCollections,
        location: 'collection',
        requireConfirmation: true,
        requireSelection: false,
      },
      status: 'inactive',
      trigger: 'manual',
    }),
    method: 'POST',
  });

  await request('/operations', {
    body: JSON.stringify({
      flow: flowId,
      id: operationId,
      key: 'rebuild_derived_data',
      name: 'Rebuild derived data',
      options: {},
      position_x: 19,
      position_y: 1,
      resolve: null,
      type: 'finki-hub-rebuild-derived-data',
    }),
    method: 'POST',
  });

  await request(`/flows/${flowId}`, {
    body: JSON.stringify({ operation: operationId, status: 'active' }),
    method: 'PATCH',
  });

  return flowId;
};
