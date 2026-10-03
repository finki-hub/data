import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { FlowInstallSummary } from '../flows/install-flows.js';

import {
  dataStatusPanelId,
  runOperationPanelId,
  type StatusSection,
} from '../../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import { ruleSeedingFlowId } from '../flows/add-enrollment-rules.js';
import { rulesId } from '../flows/flow-template.js';
import { markPendingFlowId } from '../flows/mark-pending.js';
import { publishAssetsFlowId } from '../flows/publish-public-assets.js';
import { snapshotFlowId } from '../flows/snapshot-import.js';

// The Data operations dashboard npm run setup installs once: one Insights
// dashboard and its default panels as directus_panels rows under
// deterministic ids. A rerun creates what is missing (a deleted panel comes
// back) and never overwrites an edit of the dashboard or a panel. Another
// action is a Run operation panel added in Studio for any installed
// Data / or Publish / Flow; no code changes.

export const operationsDashboardId = rulesId('d0');

const operationsDashboard = {
  color: null,
  icon: 'monitor_heart',
  id: operationsDashboardId,
  name: 'Data operations',
  note: 'Calculations, published files, readiness checks, published keys and manual data operations.',
} as const;

type PanelDeclaration = {
  readonly height: number;
  readonly icon: string;
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly type: string;
  readonly width: number;
  readonly x: number;
  readonly y: number;
};

const runPanel = (
  panel: Omit<PanelDeclaration, 'height' | 'options' | 'type' | 'width' | 'y'>,
  flow: string,
): PanelDeclaration => ({
  ...panel,
  height: 12,
  options: { flow: { collection: 'directus_flows', key: flow } },
  type: runOperationPanelId,
  width: 13,
  y: 1,
});

const statusPanel = (
  panel: Omit<PanelDeclaration, 'options' | 'type'>,
  sections: readonly StatusSection[],
): PanelDeclaration => ({
  ...panel,
  options: { sections: [...sections] },
  type: dataStatusPanelId,
});

// Publish, Recalculate, Import snapshot and Add enrollment rules in the
// first row, the status below.
export const defaultPanels: readonly PanelDeclaration[] = [
  runPanel(
    {
      icon: 'cloud_upload',
      id: rulesId('d1'),
      name: 'Publish',
      note: 'Publishes every declared public file.',
      x: 1,
    },
    publishAssetsFlowId,
  ),
  runPanel(
    {
      icon: 'update',
      id: rulesId('d2'),
      name: 'Recalculate',
      note: 'Marks domains pending; also retries a failed calculation.',
      x: 14,
    },
    markPendingFlowId,
  ),
  runPanel(
    {
      icon: 'upload_file',
      id: rulesId('d3'),
      name: 'Import Moodle snapshot',
      note: 'Replaces the active Moodle snapshot with a private CSV.',
      x: 27,
    },
    snapshotFlowId,
  ),
  runPanel(
    {
      icon: 'playlist_add',
      id: rulesId('d4'),
      name: 'Add enrollment rules',
      note: 'Seeds the missing rules of a new academic year or course.',
      x: 40,
    },
    ruleSeedingFlowId,
  ),
  statusPanel(
    {
      height: 32,
      icon: 'monitor_heart',
      id: rulesId('d5'),
      name: 'Calculations and published files',
      note: 'Shows calculation domains and published files.',
      width: 26,
      x: 1,
      y: 13,
    },
    ['operations'],
  ),
  statusPanel(
    {
      height: 32,
      icon: 'fact_check',
      id: rulesId('d6'),
      name: 'Readiness',
      note: 'Shows readiness checks with one Studio link each.',
      width: 26,
      x: 27,
      y: 13,
    },
    ['readiness'],
  ),
  statusPanel(
    {
      height: 14,
      icon: 'key',
      id: rulesId('d7'),
      name: 'Published keys',
      note: 'Shows the rows whose flags decide the public keys.',
      width: 52,
      x: 1,
      y: 45,
    },
    ['keys'],
  ),
];

const idRows = z.array(z.object({ id: z.string() }));

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  method: 'POST',
});

const panelPayload = (panel: PanelDeclaration) => ({
  color: null,
  dashboard: operationsDashboardId,
  height: panel.height,
  icon: panel.icon,
  id: panel.id,
  name: panel.name,
  note: panel.note,
  options: panel.options,
  position_x: panel.x,
  position_y: panel.y,
  show_header: true,
  type: panel.type,
  width: panel.width,
});

// Creates the dashboard and each default panel that is missing; reports
// what it created and what it left as it was, by name.
export const installOperationsDashboard = async (
  request: DirectusRequest,
  panels: readonly PanelDeclaration[] = defaultPanels,
): Promise<FlowInstallSummary> => {
  const created: string[] = [];
  const skipped: string[] = [];
  const [dashboard] = idRows.parse(
    await request(
      `/dashboards?fields=id&limit=1&filter[id][_eq]=${operationsDashboardId}`,
    ),
  );
  if (dashboard === undefined) {
    await request('/dashboards', json(operationsDashboard));
    created.push(operationsDashboard.name);
  } else {
    skipped.push(operationsDashboard.name);
  }
  const ids = panels.map(({ id }) => id).join(',');
  const present = new Set(
    idRows
      .parse(await request(`/panels?fields=id&limit=-1&filter[id][_in]=${ids}`))
      .map(({ id }) => id),
  );
  const missing = panels.filter(({ id }) => !present.has(id));
  if (missing.length > 0) {
    await request('/panels', json(missing.map((panel) => panelPayload(panel))));
  }
  for (const { id, name } of panels) {
    (present.has(id) ? skipped : created).push(name);
  }
  return { created, skipped };
};
