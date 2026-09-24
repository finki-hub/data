import type { EnumChoice } from '../schema.js';

import {
  claimDomains,
  domainLabel,
  importStates,
  publicationStates,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { ruleModes } from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { labelledChoices } from './fields.js';

// The vocabularies of the operations collections. The coordinator's own
// (domains, claim domains, import and publication states) are declared
// once in the data-operations extension and imported here; the labels
// Studio shows are declared here once per value, and setup keeps
// installed fields in step with them.

// The enrollment rule modes carry their labels in their one declaration
// (rule-modes.ts), with what each does and whether it reads `pattern`.
export const modeChoices: readonly EnumChoice[] = ruleModes.map(
  ({ label, mode }) => ({ label, value: mode }),
);

const modeDoes = ({ description, mode }: (typeof ruleModes)[number]): string =>
  `${mode} ${description}`;

export const modeNote = `${ruleModes.map(modeDoes).join('; ')}.`;

export const patternNote = `Literal regular expression retained from the checkpoint; only used by ${ruleModes
  .filter(({ usesPattern }) => usesPattern)
  .map(({ mode }) => mode)
  .join(', ')}.`;

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
