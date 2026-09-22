import type { DirectusRequest } from '../directus-request.js';
import type { FlowTemplate } from './flow-template.js';

import { pageFlow, runFlow } from './history-page-flows.js';
import { runnerFlow } from './history-runner-flow.js';
import {
  type FlowInstallSummary,
  installFlowTemplates,
} from './install-flows.js';

// The Moodle history index Flows in installation order: the page Flow
// before the run Flow that calls it, the manual runner last.
export const historyIndexFlows: readonly FlowTemplate[] = [
  pageFlow,
  runFlow,
  runnerFlow,
];

// Installs the history index Flows once each; a Flow whose id exists keeps
// every Studio edit (see installFlowTemplates).
export const installHistoryIndexFlows = (
  request: DirectusRequest,
): Promise<FlowInstallSummary> =>
  installFlowTemplates(request, historyIndexFlows);
