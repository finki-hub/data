import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import {
  familyId,
  flowFamilyCodes,
  type FlowTemplate,
} from '../src/flows/flow-template.js';
import {
  flowFamilies,
  type FlowFamily,
  flowTemplates,
  installFlowFamilies,
} from '../src/flows/registry.js';

const idPrefix = '6a1d9f0e-2b3c-4d5e-8f70-00000000';

// The Flows the fixture has installed, in installation order, by the last
// four digits of their ids (family code and suffix): a template refactor
// must never change them, because setup skips a Flow whose id exists.
const installedFlowIds = [
  '0902',
  '0901',
  '0904',
  '1001',
  '1101',
  '1102',
  '1202',
  '1203',
  '1201',
  '1404',
  '1405',
  '1301',
  '1303',
  '1302',
];

// The 171 operation ids of those Flows, sorted and hashed.
const operationIdsSha256 =
  '6858e870a5fb769ab5e64a027b3d56deb9364915d519cdf3161a950b08173ee8';

const codeOf = (id: string): string =>
  id.startsWith(idPrefix) ? id.slice(idPrefix.length, idPrefix.length + 2) : '';

// Every id a template carries: the Flow, its entry, each operation and the
// targets of its edges.
const idsOf = (template: FlowTemplate): string[] => [
  template.id,
  template.entry,
  ...template.operations.flatMap(({ id, reject, resolve }) => [
    id,
    ...(reject === null ? [] : [reject]),
    ...(resolve === null ? [] : [resolve]),
  ]),
];

const childFlow = z.object({ flow: z.string() });
const idFilterPattern = /\[_eq\]=(?<id>.+)$/u;

const byText = (left: string, right: string): number =>
  left.localeCompare(right);

const nameOf = ({ name }: FlowTemplate): string => name;

const operationIds = ({ operations }: FlowTemplate): string[] =>
  operations.map(({ id }) => id);

// A filter for the children installed at or after their parent.
const installedAfter =
  (order: readonly string[], parent: string) =>
  (child: string): boolean =>
    order.indexOf(child) >= order.indexOf(parent);

// A filter for the ids that do not carry the family code.
const notOf =
  (code: string) =>
  (id: string): boolean =>
    codeOf(id) !== code;

// The Flows a template triggers through a Trigger Flow step.
const childrenOf = (template: FlowTemplate): string[] =>
  template.operations.flatMap(({ options, type }) => {
    const parsed = childFlow.safeParse(options);
    return type === 'trigger' && parsed.success ? [parsed.data.flow] : [];
  });

describe('the Flow family registry', () => {
  test('registers every declared family code exactly once', () => {
    const codes = flowFamilies.map(({ code }) => code);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.toSorted(byText)).toEqual(
      Object.values(flowFamilyCodes).toSorted(byText),
    );
  });

  test('keeps the installed Flow and operation ids unchanged', () => {
    const templates = flowTemplates();
    const operations = templates.flatMap(operationIds).toSorted(byText);

    expect(templates.map(({ id }) => id.slice(-4))).toEqual(installedFlowIds);
    expect(operations).toHaveLength(171);
    expect(
      createHash('sha256').update(operations.join(',')).digest('hex'),
    ).toBe(operationIdsSha256);
    expect(templates.map(({ id }) => id)).toContain(familyId('14', '04'));
    expect(templates.map(({ id }) => id)).toContain(familyId('14', '05'));
  });

  test('uses every id once across all templates', () => {
    const ids = flowTemplates().flatMap((template) => [
      template.id,
      ...operationIds(template),
    ]);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test('gives every id of a family its family code', () => {
    const foreign = flowFamilies.flatMap(({ code, templates }) =>
      templates.flatMap(idsOf).filter(notOf(code)),
    );

    expect(foreign).toEqual([]);
  });

  test('installs every triggered child before its parent and the schedule last', () => {
    const order = flowTemplates().map(({ id }) => id);
    const late = flowTemplates().flatMap((template) =>
      childrenOf(template).filter(installedAfter(order, template.id)),
    );
    const schedules = flowTemplates().filter(
      ({ trigger }) => trigger === 'schedule',
    );

    expect(late).toEqual([]);
    expect(schedules).toHaveLength(1);
    expect(flowTemplates().at(-1)).toBe(schedules[0]);
    expect(flowFamilies.at(-1)?.code).toBe(flowFamilyCodes.automation);
  });

  test('triggers only registered Flows', () => {
    const known = new Set(flowTemplates().map(({ id }) => id));
    const unknown = flowTemplates()
      .flatMap(childrenOf)
      .filter((child) => !known.has(child));

    expect(unknown).toEqual([]);
  });
});

describe('the one install loop', () => {
  const flowBody = z.object({ id: z.string() });

  // A project that records every call and remembers the Flows created.
  const project = () => {
    const present = new Set<string>();
    const calls: Array<{ method: string; pathname: string }> = [];
    const request: DirectusRequest = async (pathname, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, pathname });
      if (method === 'GET') {
        const id = idFilterPattern.exec(pathname)?.groups?.['id'];
        return id !== undefined && present.has(id)
          ? [{ id, operation: `${id}-entry` }]
          : [];
      }
      if (pathname === '/flows' && typeof init?.body === 'string') {
        present.add(flowBody.parse(JSON.parse(init.body)).id);
      }
      return {};
    };
    return { calls, request };
  };

  test('installs every family in registry order and reports each', async () => {
    const { calls, request } = project();

    const first = await installFlowFamilies(request);

    expect(first.created).toEqual(flowTemplates().map(nameOf));
    expect(first.skipped).toEqual([]);
    expect(first.families.map(({ code, name }) => ({ code, name }))).toEqual(
      flowFamilies.map(({ code, name }) => ({ code, name })),
    );
    expect(
      calls.filter(
        ({ method, pathname }) => method === 'POST' && pathname === '/flows',
      ),
    ).toHaveLength(flowTemplates().length);

    calls.length = 0;
    const second = await installFlowFamilies(request);

    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(flowTemplates().map(nameOf));
    expect(second.families.map(({ skipped }) => skipped)).toEqual(
      flowFamilies.map(({ templates }) => templates.map(nameOf)),
    );
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  test('installs a family added to the list without any other change', async () => {
    const extra: FlowFamily = {
      code: flowFamilyCodes.publication,
      name: 'Synthetic family',
      templates: [],
    };
    const { request } = project();

    const summary = await installFlowFamilies(request, [
      ...flowFamilies,
      extra,
    ]);

    expect(summary.families.at(-1)).toEqual({
      code: flowFamilyCodes.publication,
      created: [],
      name: 'Synthetic family',
      skipped: [],
    });
  });
});
