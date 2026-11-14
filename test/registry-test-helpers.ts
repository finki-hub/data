import type { FlowTemplate } from '../src/flows/flow-template.js';

import { flowFamilies } from '../src/flows/registry.js';

// A lookup over the declared Flow registry that only tests need.

// Every template of every registered Flow family, in installation order.
export const flowTemplates = (): readonly FlowTemplate[] =>
  flowFamilies.flatMap(({ templates }) => templates);
