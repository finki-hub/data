import type { DirectusRequest } from '../directus-request.js';
import type { FlowInstallSummary } from '../flows/install-flows.js';

import { dashboardId } from '../flows/flow-template.js';
import {
  type DashboardDeclaration,
  installDashboard,
  type PanelDeclaration,
} from './operations-dashboard.js';

// The Statistics dashboard npm run setup installs once, like Data
// operations: Directus's own bar charts, each grouping and aggregating a
// public collection as it is read, so nothing is stored for them and the
// same grouping is open to any API reader (aggregate and groupBy). A rerun
// creates what is missing and never overwrites an edit.

export const statisticsDashboardId = dashboardId('e0');

const statisticsDashboard: DashboardDeclaration = {
  color: null,
  icon: 'insights',
  id: statisticsDashboardId,
  name: 'Statistics',
  note: 'Theses, teaching load and enrollments, computed as they are read.',
};

type BarChart = {
  readonly collection: string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly function: 'count' | 'sum';
  readonly horizontal?: true;
  readonly xAxis: string;
  // The field of the related row a relational x axis shows.
  readonly xAxisDisplayField?: string;
  readonly yAxis: string;
};

const barChart = (
  panel: Omit<PanelDeclaration, 'options' | 'type'>,
  chart: BarChart,
): PanelDeclaration => ({
  ...panel,
  options: {
    ...chart,
    filter: chart.filter ?? null,
    horizontal: chart.horizontal ?? false,
  },
  type: 'bar-chart',
});

const staffAxis = { xAxis: 'staff', xAxisDisplayField: 'name' } as const;

export const statisticsPanels: readonly PanelDeclaration[] = [
  barChart(
    {
      height: 16,
      icon: 'school',
      id: dashboardId('e1'),
      name: 'Bachelor theses per year',
      note: 'By the year they were submitted.',
      width: 26,
      x: 1,
      y: 1,
    },
    {
      collection: 'bachelor_theses',
      function: 'count',
      xAxis: 'year',
      yAxis: 'id',
    },
  ),
  barChart(
    {
      height: 16,
      icon: 'history_edu',
      id: dashboardId('e2'),
      name: 'Master theses per year',
      note: 'By the year they were defended.',
      width: 26,
      x: 27,
      y: 1,
    },
    {
      collection: 'master_theses',
      function: 'count',
      xAxis: 'year',
      yAxis: 'id',
    },
  ),
  barChart(
    {
      height: 48,
      icon: 'supervisor_account',
      id: dashboardId('e3'),
      name: 'Bachelor theses mentored',
      note: 'Every year, by staff member.',
      width: 26,
      x: 1,
      y: 17,
    },
    {
      ...staffAxis,
      collection: 'bachelor_thesis_staff',
      filter: { role: { _eq: 'mentor' } },
      function: 'count',
      horizontal: true,
      yAxis: 'id',
    },
  ),
  barChart(
    {
      height: 48,
      icon: 'co_present',
      id: dashboardId('e4'),
      name: 'Teaching load',
      note: 'Weekly periods summed over the six published semesters, by staff member.',
      width: 26,
      x: 27,
      y: 17,
    },
    {
      ...staffAxis,
      collection: 'course_teaching',
      filter: { timetable: { recent: { _eq: true } } },
      function: 'sum',
      horizontal: true,
      yAxis: 'periods',
    },
  ),
  barChart(
    {
      height: 16,
      icon: 'groups',
      id: dashboardId('e5'),
      name: 'Course enrollments per year',
      note: 'Enrollments summed over every course, by academic year.',
      width: 52,
      x: 1,
      y: 65,
    },
    {
      collection: 'course_enrollments',
      function: 'sum',
      xAxis: 'academic_year',
      xAxisDisplayField: 'label',
      yAxis: 'count',
    },
  ),
];

export const installStatisticsDashboard = (
  request: DirectusRequest,
  panels: readonly PanelDeclaration[] = statisticsPanels,
): Promise<FlowInstallSummary> =>
  installDashboard(request, statisticsDashboard, panels);
