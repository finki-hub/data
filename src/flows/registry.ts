import type { DirectusRequest } from '../directus-request.js';

import { enrollmentRuleFlows } from './add-enrollment-rules.js';
import { legacyEnrollmentFlows } from './count-legacy-enrollments.js';
import { mappedEnrollmentFlows } from './count-mapped-enrollments.js';
import {
  type FlowFamilyCode,
  flowFamilyCodes,
  type FlowTemplate,
} from './flow-template.js';
import { historyIndexFlows } from './index-histories.js';
import {
  type FlowInstallSummary,
  installFlowTemplates,
} from './install-flows.js';
import { publicationFlows } from './prepare-public-assets.js';
import { automaticProcessingFlows } from './process-pending.js';
import { publishFlows } from './publish-public-assets.js';
import { snapshotImportFlows } from './snapshot-import.js';

// One managed Flow family: its declared code (every id of its templates
// carries it), a name for the setup report and its templates in
// installation order (children before the Flows that call them).
export type FlowFamily = {
  readonly code: FlowFamilyCode;
  readonly name: string;
  readonly templates: readonly FlowTemplate[];
};

// Every managed Flow family in installation order: the history index,
// the snapshot import, the mapped and legacy enrollment counts, the
// publication buttons, the publish Flows and the rule seeding of the
// dashboard before automatic processing, whose dispatcher calls the
// enrollment Flows and whose schedule runs last, so its first tick finds
// every child. A later family is one entry here, before automatic
// processing.
export const flowFamilies: readonly FlowFamily[] = [
  {
    code: flowFamilyCodes.history,
    name: 'History index',
    templates: historyIndexFlows,
  },
  {
    code: flowFamilyCodes.snapshot,
    name: 'Snapshot import',
    templates: snapshotImportFlows,
  },
  {
    code: flowFamilyCodes.mapped,
    name: 'Mapped enrollments',
    templates: mappedEnrollmentFlows,
  },
  {
    code: flowFamilyCodes.legacy,
    name: 'Legacy enrollments',
    templates: legacyEnrollmentFlows,
  },
  {
    code: flowFamilyCodes.publication,
    name: 'Publication',
    templates: publicationFlows,
  },
  {
    code: flowFamilyCodes.publish,
    name: 'Publish',
    templates: publishFlows,
  },
  {
    code: flowFamilyCodes.rules,
    name: 'Enrollment rules',
    templates: enrollmentRuleFlows,
  },
  {
    code: flowFamilyCodes.automation,
    name: 'Automatic processing',
    templates: automaticProcessingFlows,
  },
];

// The registered family of a code.
export const flowFamily = (
  code: FlowFamilyCode,
  families: readonly FlowFamily[] = flowFamilies,
): FlowFamily => {
  const family = families.find((candidate) => candidate.code === code);
  if (family === undefined) {
    throw new Error(`Flow family ${code} is not registered`);
  }
  return family;
};

type FamilyReport = FlowInstallSummary & {
  readonly code: FlowFamilyCode;
  readonly name: string;
};

type FlowFamiliesSummary = FlowInstallSummary & {
  readonly families: readonly FamilyReport[];
};

// Installs one registered family once (see installFlowTemplates).
export const installFlowFamily = async (
  request: DirectusRequest,
  code: FlowFamilyCode,
): Promise<FamilyReport> => {
  const family = flowFamily(code);
  return {
    code,
    name: family.name,
    ...(await installFlowTemplates(request, family.templates)),
  };
};

// The one install loop of setup: every family in registry order, each Flow
// once; a Flow whose id exists keeps every Studio edit. Reports the created
// and skipped Flows in installation order and per family.
export const installFlowFamilies = async (
  request: DirectusRequest,
  families: readonly FlowFamily[] = flowFamilies,
): Promise<FlowFamiliesSummary> => {
  const reports: FamilyReport[] = [];
  for (const { code, name, templates } of families) {
    reports.push({
      code,
      name,
      ...(await installFlowTemplates(request, templates)),
    });
  }
  return {
    created: reports.flatMap(({ created }) => created),
    families: reports,
    skipped: reports.flatMap(({ skipped }) => skipped),
  };
};
