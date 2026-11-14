import type { EnumChoice } from '../schema.js';

import {
  claimDomains,
  domainLabel,
  importStates,
  stateLabels,
} from '../../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { labelledChoices } from './fields.js';

// The vocabularies of the operations collections. The coordinator's own
// (domains, claim domains, import states, and the one
// label of each state, which the dashboard shows too) are declared once in
// the data-operations extension and imported here; setup keeps installed
// fields in step with them.

export const importChoices = labelledChoices(importStates, stateLabels);

// A claim domain shows the label its declaration gives it.
export const claimChoices: readonly EnumChoice[] = claimDomains.map(
  (value) => ({ label: domainLabel(value), value }),
);
