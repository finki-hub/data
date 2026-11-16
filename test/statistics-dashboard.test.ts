import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { insertThesesSql } from '../directus/extensions/directus-extension-data-operations/src/theses/sql.js';
import {
  bachelorTable,
  masterTable,
} from '../directus/extensions/directus-extension-data-operations/src/theses/vocabulary.js';
import { publicReads } from '../src/data-model/access.js';
import { dataModelCollections } from '../src/data-model/collections.js';
import {
  installStatisticsDashboard,
  statisticsDashboardId,
  statisticsPanels,
} from '../src/data-model/statistics-dashboard.js';

const chartOptions = z.object({
  collection: z.string(),
  function: z.enum(['count', 'sum']),
  xAxis: z.string(),
  xAxisDisplayField: z.string().optional(),
  yAxis: z.string(),
});

const panelIds = statisticsPanels.map(({ id }) => ({ id }));

const fieldsOf = (collection: string): string[] =>
  dataModelCollections
    .find((declared) => declared.collection === collection)
    ?.fields.map(({ field }) => field) ?? [];

const relatedOf = (collection: string, field: string): string | undefined => {
  const declared = dataModelCollections
    .find((candidate) => candidate.collection === collection)
    ?.fields.find((candidate) => candidate.field === field);
  return declared?.kind === 'm2o' ? declared.related : undefined;
};

// What a chart reads that is private or undeclared.
const chartProblems = (
  chart: z.infer<typeof chartOptions>,
  publicCollections: ReadonlySet<string>,
): string[] => {
  const fields = new Set(['id', ...fieldsOf(chart.collection)]);
  const display = chart.xAxisDisplayField;
  return [
    ...(publicCollections.has(chart.collection)
      ? []
      : [`${chart.collection}: private`]),
    ...[chart.xAxis, chart.yAxis]
      .filter((field) => !fields.has(field))
      .map((field) => `${chart.collection}.${field}: undeclared`),
    ...(display === undefined ||
    fieldsOf(relatedOf(chart.collection, chart.xAxis) ?? '').includes(display)
      ? []
      : [`${chart.collection}.${chart.xAxis}.${display}: undeclared`]),
  ];
};

describe('the Statistics dashboard', () => {
  test('charts only public collections, by fields the model declares', () => {
    const publicCollections = new Set<string>(
      publicReads.map(({ collection }) => collection),
    );
    const charts = statisticsPanels.map(({ options }) =>
      chartOptions.parse(options),
    );
    const problems = charts.flatMap((chart) =>
      chartProblems(chart, publicCollections),
    );

    expect(problems).toEqual([]);
    expect(new Set(statisticsPanels.map(({ id }) => id)).size).toBe(
      statisticsPanels.length,
    );
  });

  test('installs once and leaves an existing dashboard and its panels as they are', async () => {
    const calls: string[] = [];
    const first = await installStatisticsDashboard((path, init) => {
      const query = path.indexOf('?');
      calls.push(
        `${init?.method ?? 'GET'} ${query === -1 ? path : path.slice(0, query)}`,
      );
      return Promise.resolve([]);
    });

    expect(first.created).toEqual([
      'Statistics',
      ...statisticsPanels.map(({ name }) => name),
    ]);
    expect(calls).toEqual([
      'GET /dashboards',
      'POST /dashboards',
      'GET /panels',
      'POST /panels',
    ]);

    const again = await installStatisticsDashboard((path) =>
      Promise.resolve(
        path.startsWith('/dashboards')
          ? [{ id: statisticsDashboardId }]
          : panelIds,
      ),
    );

    expect(again.created).toEqual([]);
  });

  test('groups every thesis by the year of its day', () => {
    expect(insertThesesSql(bachelorTable)).toContain(
      'left(r."submitted", 4)::integer',
    );
    expect(insertThesesSql(masterTable)).toContain(
      'left(r."presented", 4)::integer',
    );
  });
});
