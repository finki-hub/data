import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { FlowInstallSummary } from '../flows/install-flows.js';

import {
  dataStatusPanelId,
  runOperationPanelId,
  type StatusSection,
} from '../../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import { dashboardId } from '../flows/flow-template.js';
import { markPendingFlowId } from '../flows/mark-pending.js';
import { snapshotFlowId } from '../flows/snapshot-import.js';

// The Data operations dashboard npm run setup installs once: one Insights
// dashboard and its default panels as directus_panels rows under
// deterministic ids. A rerun creates what is missing (a deleted panel comes
// back) and never overwrites an edit of the dashboard or a panel. Another
// action is a Run operation panel added in Studio for any installed
// Data / Flow; no code changes.

export const operationsDashboardId = dashboardId('d0');

const operationsDashboard: DashboardDeclaration = {
  color: null,
  icon: 'monitor_heart',
  id: operationsDashboardId,
  name: 'Data operations',
  note: 'Calculations, published keys and manual data operations.',
};

export type DashboardDeclaration = {
  readonly color: null;
  readonly icon: string;
  readonly id: string;
  readonly name: string;
  readonly note: string;
};

export type PanelDeclaration = {
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
  panel: Omit<PanelDeclaration, 'height' | 'options' | 'type' | 'y'>,
  flow: string,
): PanelDeclaration => ({
  ...panel,
  height: 12,
  options: { flow: { collection: 'directus_flows', key: flow } },
  type: runOperationPanelId,
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

// Recalculate and Import snapshot in the first row, as wide as the status
// rows below: Needs attention, Calculations, Published keys. The ids keep their suffixes: d1 held the retired Publish
// panel, d4 the retired Add enrollment rules panel and d6 the retired
// Readiness panel.
export const defaultPanels: readonly PanelDeclaration[] = [
  runPanel(
    {
      icon: 'update',
      id: dashboardId('d2'),
      name: 'Recalculate',
      note: 'Marks domains pending; also retries a failed calculation.',
      width: 26,
      x: 1,
    },
    markPendingFlowId,
  ),
  runPanel(
    {
      icon: 'upload_file',
      id: dashboardId('d3'),
      name: 'Import Moodle snapshot',
      note: 'Replaces the active Moodle snapshot with a private CSV.',
      width: 26,
      x: 27,
    },
    snapshotFlowId,
  ),
  statusPanel(
    {
      height: 24,
      icon: 'report',
      id: dashboardId('d8'),
      name: 'Needs attention',
      note: 'Shows data that is not linked up yet.',
      width: 52,
      x: 1,
      y: 13,
    },
    ['attention'],
  ),
  statusPanel(
    {
      height: 32,
      icon: 'monitor_heart',
      id: dashboardId('d5'),
      name: 'Calculations',
      note: 'Shows the calculation domains and the Moodle snapshot.',
      width: 52,
      x: 1,
      y: 37,
    },
    ['operations'],
  ),
  statusPanel(
    {
      height: 14,
      icon: 'key',
      id: dashboardId('d7'),
      name: 'Published keys',
      note: 'Shows the rows whose flags decide the public keys.',
      width: 52,
      x: 1,
      y: 69,
    },
    ['keys'],
  ),
];

const idRows = z.array(z.object({ id: z.string() }));

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  method: 'POST',
});

const panelPayload = (dashboard: string, panel: PanelDeclaration) => ({
  color: null,
  dashboard,
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

// Creates a dashboard and each of its panels that is missing; reports
// what it created and what it left as it was, by name.
export const installDashboard = async (
  request: DirectusRequest,
  declaration: DashboardDeclaration,
  panels: readonly PanelDeclaration[],
): Promise<FlowInstallSummary> => {
  const created: string[] = [];
  const skipped: string[] = [];
  const [dashboard] = idRows.parse(
    await request(
      `/dashboards?fields=id&limit=1&filter[id][_eq]=${declaration.id}`,
    ),
  );
  if (dashboard === undefined) {
    await request('/dashboards', json(declaration));
    created.push(declaration.name);
  } else {
    skipped.push(declaration.name);
  }
  const ids = panels.map(({ id }) => id).join(',');
  const present = new Set(
    idRows
      .parse(await request(`/panels?fields=id&limit=-1&filter[id][_in]=${ids}`))
      .map(({ id }) => id),
  );
  const missing = panels.filter(({ id }) => !present.has(id));
  if (missing.length > 0) {
    await request(
      '/panels',
      json(missing.map((panel) => panelPayload(declaration.id, panel))),
    );
  }
  for (const { id, name } of panels) {
    (present.has(id) ? skipped : created).push(name);
  }
  return { created, skipped };
};

export const installOperationsDashboard = (
  request: DirectusRequest,
  panels: readonly PanelDeclaration[] = defaultPanels,
): Promise<FlowInstallSummary> =>
  installDashboard(request, operationsDashboard, panels);
