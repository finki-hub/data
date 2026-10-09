import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import { enrollmentRuleFlows } from '../src/flows/add-enrollment-rules.js';
import {
  familyId,
  flowFamilyCodes,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import { matchingFlows } from '../src/flows/match-history-lines.js';
import { publishFlows } from '../src/flows/publish-public-assets.js';
import {
  flowFamilies,
  type FlowFamily,
  installFlowFamilies,
} from '../src/flows/registry.js';
import { flowTemplates } from './registry-test-helpers.js';

const idPrefix = '6a1d9f0e-2b3c-4d5e-8f70-00000000';

// The Flows the fixture has installed, in installation order, by the last
// four digits of their ids (family code and suffix): a template refactor
// must never change them, because setup skips a Flow whose id exists.
const installedFlowIds = [
  '0902',
  '0901',
  '0904',
  '1001',
  // Batch 1, step 15: the history line matching family, in place of the
  // mapped (11) and legacy (12) families.
  '1701',
  '1404',
  '1405',
  // Task 15: the publish family, the child before its parent.
  '1502',
  '1501',
  // Task 16: the rule seeding family, the batch child before its parent.
  '1602',
  '1601',
  '1301',
  '1303',
  '1302',
];

// The two-digit suffixes from `first` to `last`, in hex order.
const suffixes = (first: string, last: string): string[] =>
  Array.from(
    { length: Number.parseInt(last, 16) - Number.parseInt(first, 16) + 1 },
    (_, index) =>
      (Number.parseInt(first, 16) + index).toString(16).padStart(2, '0'),
  );

// The id of a step of a family, retired codes included.
const anyFamilyId = (code: string, suffix: string): string =>
  `${idPrefix}${code}${suffix}`;

const idsIn = (code: string, ...ranges: Array<[string, string]>): string[] =>
  ranges.flatMap(([first, last]) =>
    suffixes(first, last).map((suffix) => anyFamilyId(code, suffix)),
  );

// What batch 1 step 15 removed with the rule families: the operations of
// the mapped and legacy Flows that the pinned ids below held (the pair and
// page Flows of family 11; the parent, page and zero Flows of family 12).
const ruleFamilyOperationIds = [
  ...idsIn('11', ['11', '16'], ['21', '2e']),
  ...idsIn('12', ['11', '17'], ['41', '4c']),
  ...idsIn('12', ['21', '2d'], ['51', '56']),
  ...idsIn('12', ['31', '3d'], ['61', '66']),
];

// The Flows step 15 removed and the operations of those added after the
// pin (Task 26: the mapped family's runner and the family runner).
const retiredRunnerIds = [
  ...idsIn('11', ['01', '03']),
  ...idsIn('12', ['01', '03']),
  familyId('13', '04'),
  ...idsIn('11', ['31', '3a']),
  ...idsIn('13', ['61', '65'], ['71', '78']),
];

// The 171 operation ids the fixture held before Task 15, sorted and
// hashed.
const operationIdsSha256 =
  '6858e870a5fb769ab5e64a027b3d56deb9364915d519cdf3161a950b08173ee8';

// What Task 15 added: every operation of the publish family, and the
// schedule's enrollment route and unknown-domain branch. What Task 16
// added: every operation of the rule seeding family. What batch 1 step 15
// added: every operation of the matching family.
const addedOperationIds = new Set([
  ...publishFlows.flatMap(({ operations }) => operations.map(({ id }) => id)),
  familyId('13', '3a'),
  familyId('13', '4a'),
  familyId('13', '49'),
  ...[...enrollmentRuleFlows, ...matchingFlows].flatMap(({ operations }) =>
    operations.map(({ id }) => id),
  ),
]);

// The two steps each manual Flow of families 10, 13 and 14 started with
// until 2026-10-03, part of the pinned ids above.
const pinnedGateIds = [
  familyId('10', '11'),
  familyId('10', '21'),
  familyId('13', '51'),
  familyId('13', '55'),
  familyId('14', '41'),
  familyId('14', '42'),
  familyId('14', '51'),
  familyId('14', '52'),
];

// The steps removed later, part of the pinned ids above: the dispatcher
// steps Task 26 replaced by its family loop (its other steps keep their
// ids), the gate steps above, and the rule families' operations.
const removedOperationIds = [
  ...['17', '18', '19', '2b', '2c', '2d', '2e', '2f', '30'].map((suffix) =>
    familyId('13', suffix),
  ),
  ...pinnedGateIds,
  ...ruleFamilyOperationIds,
];

// Every removed Flow and step, never reused: the ones above, the two
// steps each manual Flow of families 15 and 16 started with until
// 2026-10-03 (added after Task 15, so not pinned), and the runners. A
// project installed earlier keeps them, and setup creates Flows and
// operations under these fixed ids, so a template that reused one would
// fail there with RECORD_NOT_UNIQUE.
const retiredOperationIds = [
  ...removedOperationIds,
  familyId('15', '11'),
  familyId('15', '12'),
  familyId('16', '11'),
  familyId('16', '21'),
  ...retiredRunnerIds,
];

// A Trigger Flow target that names no Flow but a template of its payload.
const templated = (target: string): boolean => target.includes('{{');

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

const rejectOf = ({ reject }: OperationTemplate): string[] =>
  reject === null ? [] : [reject];

const resolveOf = ({ resolve }: OperationTemplate): string[] =>
  resolve === null ? [] : [resolve];

const operationIds = ({ operations }: FlowTemplate): string[] =>
  operations.map(({ id }) => id);

// A step that tests the caller: the former first two steps of the manual
// Flows, or any option that names $accountability.
const readsCaller = ({ key, options }: OperationTemplate): boolean =>
  ['admin_only', 'raise_forbidden'].includes(key) ||
  JSON.stringify(options).includes('$accountability');

// The steps of a template that test the caller, by Flow name and key.
const callerChecksOf = ({ name, operations }: FlowTemplate): string[] =>
  operations.filter(readsCaller).map(({ key }) => `${name}: ${key}`);

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

// The Flow targets of a template's Trigger Flow steps, fixed or templated.
const targetsOf = (template: FlowTemplate): string[] =>
  template.operations.flatMap(({ options, type }) => {
    const parsed = childFlow.safeParse(options);
    return type === 'trigger' && parsed.success ? [parsed.data.flow] : [];
  });

// The Flows a template triggers by id.
const childrenOf = (template: FlowTemplate): string[] =>
  targetsOf(template).filter((target) => !templated(target));

// The templated Trigger Flow targets of a template, with its id.
const templatedTargetsOf = (template: FlowTemplate): string[][] =>
  targetsOf(template)
    .filter(templated)
    .map((target) => [template.id, target]);

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

    const kept = operations.filter((id) => !addedOperationIds.has(id));
    const before = [...kept, ...removedOperationIds].toSorted(byText);

    expect(templates.map(({ id }) => id.slice(-4))).toEqual(installedFlowIds);
    expect(before).toHaveLength(171);
    expect(createHash('sha256').update(before.join(',')).digest('hex')).toBe(
      operationIdsSha256,
    );
    expect(operations.filter((id) => removedOperationIds.includes(id))).toEqual(
      [],
    );
    expect(operations).toHaveLength(
      171 - removedOperationIds.length + addedOperationIds.size,
    );
    expect(templates.map(({ id }) => id)).toContain(familyId('14', '04'));
    expect(templates.map(({ id }) => id)).toContain(familyId('14', '05'));
  });

  // No template tests its caller: the operations that need a caller check
  // run it themselves (access.ts).
  test('holds no step that reads the caller accountability', () => {
    expect(flowTemplates().flatMap(callerChecksOf)).toEqual([]);
  });

  test('reuses no removed step id', () => {
    const reused = flowTemplates()
      .flatMap(idsOf)
      .filter((id) => retiredOperationIds.includes(id));

    expect(new Set(retiredOperationIds).size).toBe(128);
    expect(ruleFamilyOperationIds).toHaveLength(77);
    expect(reused).toEqual([]);
    // No template carries a retired family code.
    expect(
      flowTemplates()
        .flatMap(idsOf)
        .filter((id) => ['11', '12'].includes(codeOf(id))),
    ).toEqual([]);
  });

  test('uses every id once across all templates', () => {
    const ids = flowTemplates().flatMap((template) => [
      template.id,
      ...operationIds(template),
    ]);

    expect(new Set(ids).size).toBe(ids.length);
  });

  // directus_operations keeps each of resolve and reject unique: two steps
  // that reject to one refusal fail the install with RECORD_NOT_UNIQUE
  // (one step may resolve and reject to the same target).
  test('points at most one resolve and one reject edge at each operation', () => {
    const operations = flowTemplates().flatMap(
      (template) => template.operations,
    );
    const rejects = operations.flatMap(rejectOf);
    const resolves = operations.flatMap(resolveOf);

    expect(new Set(rejects).size).toBe(rejects.length);
    expect(new Set(resolves).size).toBe(resolves.length);
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

  // The fingerprint follows Trigger Flow steps by id; a templated target
  // would hide its Flow from it.
  test('names every triggered Flow by a fixed id', () => {
    expect(flowTemplates().flatMap(templatedTargetsOf)).toEqual([]);
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
