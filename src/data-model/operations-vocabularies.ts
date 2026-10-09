import type { EnumChoice } from '../schema.js';

import {
  claimDomains,
  domainLabel,
  importStates,
  publicationStates,
  stateLabels,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { labelledChoices } from './fields.js';

// The vocabularies of the operations collections. The coordinator's own
// (domains, claim domains, import and publication states, and the one
// label of each state, which the dashboard shows too) are declared once in
// the data-operations extension and imported here; setup keeps installed
// fields in step with them.

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
