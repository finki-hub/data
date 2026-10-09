import type { EnumChoice } from '../schema.js';

import {
  claimDomains,
  domainLabel,
  importStates,
  publicationStates,
  stateLabels,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  ruleMode,
  ruleModes,
} from '../../directus/extensions/directus-extension-data-operations/src/rule-modes.js';
import { labelledChoices } from './fields.js';

// The vocabularies of the operations collections. The coordinator's own
// (domains, claim domains, import and publication states, and the one
// label of each state, which the dashboard shows too) are declared once in
// the data-operations extension and imported here; setup keeps installed
// fields in step with them.

// The enrollment rule modes carry their labels in their one declaration
// (rule-modes.ts), with what each does and whether it reads `pattern`.
export const modeChoices: readonly EnumChoice[] = ruleModes.map(
  ({ label, mode }) => ({ label, value: mode }),
);

const modeDoes = ({ description, mode }: (typeof ruleModes)[number]): string =>
  `${mode} ${description}`;

export const modeNote = `${ruleModes.map(modeDoes).join('; ')}.`;

// The mode Add enrollment rules gives every rule it creates.
export const addedRuleMode = ruleMode('mapped_entries').mode;

export const patternNote = `Literal regular expression, as the workbook import or a hand edit recorded it; only used by ${ruleModes
  .filter(({ usesPattern }) => usesPattern)
  .map(({ mode }) => mode)
  .join(', ')}.`;

export const importChoices = labelledChoices(importStates, stateLabels);

export const publicationChoices = labelledChoices(
  publicationStates,
  stateLabels,
);

// What each publication state means, in the labels Studio shows.
export const publicationStateNote = `${stateLabels.completed}: every declared file uploaded; ${stateLabels.partial}: some; ${stateLabels.failed}: none. Per-file outcomes in publication_outcomes.`;

// A claim domain shows the label its declaration gives it.
export const claimChoices: readonly EnumChoice[] = claimDomains.map(
  (value) => ({ label: domainLabel(value), value }),
);
