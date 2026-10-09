import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';
import type { ModelCollectionKey } from '../src/schema.js';

import {
  collectionDeclarations,
  collectionRoleNames,
  isSource,
  type RegisteredCollection,
  sourceDeclarations,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import {
  calculationDomains,
  domainDeclarations,
  normaliseDomains,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import { dataModelCollectionKeys } from '../src/data-model/collections.js';
import { flowFamilyCodes } from '../src/flows/flow-template.js';
import {
  chosenDomainsScript,
  markPendingFlow,
} from '../src/flows/mark-pending.js';
import {
  automaticProcessingFlows,
  processPendingFlow,
} from '../src/flows/process-pending.js';
import { installFlowFamily } from '../src/flows/registry.js';
import { FakeCoordination } from './data-coordination-helpers.js';
import { refusalOf, runScript } from './flow-script-helpers.js';

const history = 'history_index';

const collator = new Intl.Collator('en');
const byText = (left: string, right: string): number =>
  collator.compare(left, right);

const enrollments = 'enrollments';
const publication = 'publication';

// The domains an edit marks, read back from the fake's mirror of the
// statement triggers.
const marks = (
  table: string,
  operation: 'delete' | 'insert' | 'update',
  columns: readonly string[] = [],
) => {
  const fake = new FakeCoordination();
  fake.sourceWrite(table, operation, columns);
  return fake.data.dirtyDomains;
};

// True when the fake's statement triggers refuse a write to the table,
// as they do for every table that is no registered source.
const refused = (table: string): boolean => {
  try {
    marks(table, 'insert');
    return false;
  } catch {
    return true;
  }
};

// Compile-time proof that the registry names exactly the model collections.
type Same<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
const registryIsTheModel: Same<RegisteredCollection, ModelCollectionKey> = true;

describe('source invalidation of the completed source model', () => {
  test('declares exactly one role for every model collection', () => {
    const registered = collectionDeclarations.map(
      ({ collection }) => collection,
    );

    expect(registryIsTheModel).toBeTruthy();
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.toSorted(byText)).toEqual(
      dataModelCollectionKeys.toSorted(byText),
    );
    expect(
      [...new Set(collectionDeclarations.map(({ role }) => role))].toSorted(
        byText,
      ),
    ).toEqual([...collectionRoleNames].toSorted(byText));
  });

  test('marks the declared domains for a statement on every source and refuses any other table', () => {
    for (const { collection, invalidates } of sourceDeclarations) {
      expect(marks(collection, 'insert')).toEqual(
        normaliseDomains(invalidates),
      );
    }
    for (const declaration of collectionDeclarations) {
      const guarded = isSource(declaration) || refused(declaration.collection);

      expect(guarded).toBeTruthy();
    }
  });

  test('covers the old and the new pair of a moved or deleted mapping by marking the whole domain', () => {
    for (const table of ['moodle_course_mappings', 'moodle_pattern_mappings']) {
      for (const operation of ['update', 'delete'] as const) {
        expect(marks(table, operation, ['course', 'academic_year'])).toEqual([
          enrollments,
          publication,
        ]);
      }
    }

    expect(marks('academic_years', 'delete')).toEqual([
      enrollments,
      publication,
    ]);
  });

  test('marks the history index for a deleted entry or a hand-edited label, never for another column', () => {
    expect(marks('moodle_course_entries', 'delete')).toEqual([
      history,
      enrollments,
      publication,
    ]);
    expect(marks('moodle_course_entries', 'update', ['label'])).toEqual([
      history,
      enrollments,
      publication,
    ]);
    expect(marks('moodle_course_entries', 'update', ['first_seen'])).toEqual([
      enrollments,
      publication,
    ]);
  });
});

describe('Mark pending', () => {
  test('is a manual Flow on data_operations that marks and never runs', () => {
    expect(markPendingFlow).toMatchObject({
      accountability: 'activity',
      id: '6a1d9f0e-2b3c-4d5e-8f70-000000001303',
      name: 'Data / Mark pending',
      options: {
        async: false,
        collections: ['data_operations'],
        error_on_reject: true,
        requireSelection: false,
      },
      trigger: 'manual',
    });

    const entry = markPendingFlow.operations.find(
      ({ id }) => id === markPendingFlow.entry,
    );

    expect(entry).toMatchObject({
      key: 'domains',
      options: { code: chosenDomainsScript },
      type: 'exec',
    });
    expect(
      markPendingFlow.operations
        .map(({ options }) => options['action'])
        .filter((action) => action !== undefined),
    ).toEqual(['mark', 'status']);
    expect(
      markPendingFlow.operations.filter(({ type }) => type === 'trigger'),
    ).toEqual([]);
  });

  test('marks the chosen domains, or both calculation domains when none is chosen', () => {
    expect(runScript(chosenDomainsScript, { $trigger: { body: {} } })).toEqual([
      history,
      enrollments,
    ]);
    expect(
      runScript(chosenDomainsScript, {
        $trigger: { body: { domains: [publication] } },
      }),
    ).toEqual([publication]);
    expect(runScript(chosenDomainsScript, { $trigger: null })).toEqual([
      history,
      enrollments,
    ]);
    expect(refusalOf(() => runScript('module.exports = 1;', {}))).toContain(
      'module.exports',
    );
  });
});

const dialogChoices = z.object({
  fields: z.tuple([
    z.object({
      field: z.literal('domains'),
      meta: z.object({
        options: z.object({
          choices: z.array(z.object({ text: z.string(), value: z.string() })),
        }),
      }),
    }),
  ]),
});

describe('the declared domains', () => {
  test('are the status domains and the Mark pending choices, with their labels and default', async () => {
    const names = domainDeclarations.map(({ name }) => name);
    const report = await statusAction({
      owner: 'process-a',
      staleAfterMs: 60_000,
      store: new FakeCoordination().store,
    });

    expect(Object.keys(report.domains)).toEqual(names);
    expect(
      dialogChoices.parse(markPendingFlow.options).fields[0].meta.options
        .choices,
    ).toEqual(
      domainDeclarations.map(({ label, name }) => ({
        text: label,
        value: name,
      })),
    );
    expect(runScript(chosenDomainsScript, { $trigger: { body: {} } })).toEqual([
      ...calculationDomains,
    ]);
  });
});

const flowBody = z.looseObject({ id: z.string(), status: z.string() });

describe('installation', () => {
  test('installs the children first and the schedule last, each inactive until wired', async () => {
    const posted: Array<{ readonly id: string; readonly status: string }> = [];
    const activated: string[] = [];
    const request: DirectusRequest = async (pathname, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return [];
      }
      if (pathname === '/flows') {
        posted.push(
          flowBody.parse(
            JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
          ),
        );
      }
      if (method === 'PATCH') {
        activated.push(pathname);
      }
      return {};
    };

    await expect(
      installFlowFamily(request, flowFamilyCodes.automation),
    ).resolves.toMatchObject({
      created: [
        'Data / Count enrollments',
        'Data / Mark pending',
        'Data / Process pending',
      ],
      skipped: [],
    });
    expect(posted.map(({ status }) => status)).toEqual([
      'inactive',
      'inactive',
      'inactive',
    ]);
    expect(activated.at(-1)).toBe(`/flows/${processPendingFlow.id}`);
    expect(automaticProcessingFlows.at(-1)).toBe(processPendingFlow);
  });
});
