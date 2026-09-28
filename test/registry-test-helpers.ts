import type { ReadinessEntry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-types.js';
import type { FlowTemplate } from '../src/flows/flow-template.js';

import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { flowFamilies } from '../src/flows/registry.js';

// Lookups over two declared registries that only tests need.

// Every template of every registered Flow family, in installation order.
export const flowTemplates = (): readonly FlowTemplate[] =>
  flowFamilies.flatMap(({ templates }) => templates);

// The readiness registry entry of a code.
export const readinessEntry = (code: string): ReadinessEntry | undefined =>
  readinessRegistry.find((entry) => entry.code === code);
