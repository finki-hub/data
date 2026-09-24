import type { EnumChoice } from '../schema.js';

import {
  claimDomains,
  domainLabel,
  importStates,
  publicationStates,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { labelledChoices } from './fields.js';

// The vocabularies of the operations collections. The coordinator's own
// (domains, claim domains, import and publication states) are declared
// once in the data-operations extension and imported here; the labels
// Studio shows are declared here once per value, and setup keeps
// installed fields in step with them.

export const enrollmentRuleModes = ['mapped_entries', 'legacy_regex'] as const;

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
  completed: 'Published (every file)',
  failed: 'Failed (no file uploaded)',
  idle: 'Idle',
  partial: 'Partly published',
  running: 'Running',
});

// A claim domain shows the label its declaration gives it.
export const claimChoices: readonly EnumChoice[] = claimDomains.map(
  (value) => ({ label: domainLabel(value), value }),
);
