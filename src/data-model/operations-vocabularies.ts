import { labelledChoices } from './fields.js';

// The vocabularies of the operations collections, each declared once with
// the label Studio shows for every value; setup keeps installed fields in
// step with them.

export const enrollmentRuleModes = ['mapped_entries', 'legacy_regex'] as const;

export const importStates = [
  'idle',
  'importing',
  'validating',
  'ready',
  'promoting',
  'completed',
  'failed',
] as const;

export const publicationStates = [
  'idle',
  'running',
  'completed',
  'failed',
] as const;

// The enumerated work domains of the coordinator, in dependency order.
export const coordinationDomains = [
  'history_index',
  'enrollments',
  'publication',
] as const;

// What a claim may run: a work domain or a snapshot promotion.
export const claimDomains = [...coordinationDomains, 'snapshot'] as const;

export const modeChoices = labelledChoices(enrollmentRuleModes, {
  legacy_regex: 'Legacy regex',
  mapped_entries: 'Mapped entries',
});

export const importChoices = labelledChoices(importStates, {
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
  importing: 'Importing',
  promoting: 'Promoting',
  ready: 'Staged, ready to promote',
  validating: 'Validating',
});

export const publicationChoices = labelledChoices(publicationStates, {
  completed: 'Completed',
  failed: 'Failed',
  idle: 'Idle',
  running: 'Running',
});

export const claimChoices = labelledChoices(claimDomains, {
  enrollments: 'Enrollment counts',
  history_index: 'Moodle history index',
  publication: 'Publication',
  snapshot: 'Snapshot promotion',
});
