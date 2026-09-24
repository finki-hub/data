import {
  condition,
  exportsOperation,
  familyIds,
  type FlowFamilyCode,
  flowFamilyCodes,
  type FlowTemplate,
  operation,
  publicationId,
  raise,
} from './flow-template.js';

const family = flowFamilyCodes.publication;

export const validateReadinessFlowId = publicationId('04');

// The manual Flows of the publication family share these options: a
// button on the hidden Data Operations singleton that answers the last
// step, or its refusal with its status and code.
export const publicationButton = {
  async: false,
  collections: ['data_operations'],
  error_on_reject: true,
  location: 'both',
  requireConfirmation: false,
  requireSelection: false,
} as const;

// Any user who may read data_operations could trigger a manual Flow on it;
// the export operation reads with system rights, so the Flow is gated on
// the administrator flag (the operation checks it again). The suffixes are
// those of the gate, its refusal and the step it lets through, in the
// given family (publication unless named).
export const adminOnly = (
  suffixes: readonly [string, string, string],
  message: string,
  code: FlowFamilyCode = family,
): Array<ReturnType<typeof condition>> => {
  const id = familyIds(code);
  return [
    condition({
      edges: { reject: id(suffixes[1]), resolve: id(suffixes[2]) },
      family: code,
      filter: { $accountability: { admin: { _eq: true } } },
      key: 'admin_only',
      name: 'Administrator?',
      position: [19, 1],
      suffix: suffixes[0],
    }),
    raise({
      error: { code: 'FORBIDDEN', message, status: 403 },
      family: code,
      key: 'raise_forbidden',
      name: 'Refuse a non-administrator',
      position: [19, 19],
      suffix: suffixes[1],
    }),
  ];
};

// The readiness check on demand. Its logic lives in the export operation
// (the same code the preparation runs first), so this Flow only gates and
// calls it; it holds no coordinator step and reads nothing itself.
export const validateReadinessFlow: FlowTemplate = {
  accountability: 'activity',
  description:
    'Checks whether the public files can be prepared now (administrators only): the history index and enrollment counts current, no Moodle snapshot import running or failed, the one-time conversion complete, and every readiness check the export definitions of the data-operations extension declare for their files. Answers ready, the source revision, the blocker and warning codes with their counts and the Studio page of each; never a record. Changes nothing.',
  entry: publicationId('41'),
  icon: 'fact_check',
  id: validateReadinessFlowId,
  name: 'Data / Validate readiness',
  operations: [
    ...adminOnly(
      ['41', '42', '43'],
      'Only administrators may check the publication readiness.',
    ),
    operation({
      family,
      key: 'readiness',
      name: 'Validate readiness',
      options: { action: 'readiness' },
      position: [37, 1],
      suffix: '43',
      type: exportsOperation,
    }),
  ],
  options: publicationButton,
  trigger: 'manual',
};
