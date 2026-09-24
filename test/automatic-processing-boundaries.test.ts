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
import { derivedDataFlowId } from '../src/derived-data-flow.js';
import { importWorkbook } from '../src/directus.js';
import {
  editorForbiddenGrants,
  forbiddenByRole,
  forbiddenGrantsIn,
  readSnapshotReadiness,
  snapshotReadiness,
} from '../src/editor-policy.js';
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
import {
  findLegacyFlows,
  LegacyFlowsError,
  legacyOperationTypes,
} from '../src/legacy-flows.js';
import { exitCodes, isRefusal } from '../src/lifecycle.js';
import { FakeCoordination } from './data-coordination-helpers.js';
import {
  lifecycleDataset,
  workbookContent,
} from './fixtures/synthetic-workbook.js';
import { emptyStore, fakeImportDirectus } from './import-test-helpers.js';
import { refusalOf, runScript } from './legacy-enrollment-helpers.js';

const history = 'history_index';

const collator = new Intl.Collator('en');
const byText = (left: string, right: string): number =>
  collator.compare(left, right);

// The error a promise rejected with, or null when it resolved.
const caught = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return null;
};
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

  test('covers the old and the new pair of a moved or deleted mapping or rule by marking the whole domain', () => {
    for (const table of ['moodle_course_mappings', 'course_enrollment_rules']) {
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

  test('marks the history index for a deleted entry or a hand-edited label, never for a review', () => {
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
    expect(
      marks('moodle_course_entries', 'update', [
        'review_state',
        'review_reason',
      ]),
    ).toEqual([enrollments, publication]);
  });
});

const store = () => emptyStore();

describe('checkpoint Flows of an old deployment (follow-ups 26 and 27)', () => {
  test('recognises the checkpoint Rebuild and Publish Flows by operation type, not by name or id', () => {
    expect([...legacyOperationTypes].toSorted(byText)).toEqual([
      'finki-hub-publish-json',
      'finki-hub-publish-public-assets',
      'finki-hub-rebuild-derived-data',
    ]);
  });

  test('refuses an import beside checkpoint Flows of another id before any write', async () => {
    const legacy = store();
    legacy.flows.push(
      {
        id: 'old-publish',
        name: 'Synthetic renamed publisher',
        status: 'active',
      },
      { id: derivedDataFlowId, name: 'Rebuild derived data', status: 'active' },
    );
    legacy.operations.push(
      { flow: 'old-publish', id: 'op-1', type: 'finki-hub-publish-json' },
      {
        flow: derivedDataFlowId,
        id: 'op-2',
        type: 'finki-hub-rebuild-derived-data',
      },
    );
    const fake = fakeImportDirectus(legacy);

    await expect(findLegacyFlows(fake.request)).resolves.toEqual([
      {
        id: 'old-publish',
        name: 'Synthetic renamed publisher',
        status: 'active',
        types: ['finki-hub-publish-json'],
      },
    ]);

    const error = await caught(
      importWorkbook(
        fake.request,
        workbookContent(lifecycleDataset()),
        fake.io,
      ),
    );

    expect(error).toBeInstanceOf(LegacyFlowsError);
    expect(isRefusal(error)).toBeTruthy();
    expect(exitCodes.refused).toBe(2);
    expect(String(error)).toContain(
      '"Synthetic renamed publisher" (old-publish, active, finki-hub-publish-json)',
    );
    expect(fake.mutations()).toEqual([]);
    expect(fake.setups()).toBe(0);
  });

  test('accepts a project whose only checkpoint Flows are the import’s own', async () => {
    const own = store();
    own.flows.push({ id: derivedDataFlowId, name: 'Rebuild derived data' });
    own.operations.push({
      flow: derivedDataFlowId,
      id: 'op-2',
      type: 'finki-hub-rebuild-derived-data',
    });

    await expect(
      findLegacyFlows(fakeImportDirectus(own).request),
    ).resolves.toEqual([]);
  });
});

describe('the editor policy template and the snapshot readiness check', () => {
  test('forbids the native snapshot shortcut and every derived write, and nothing an editor needs', () => {
    const withheld = collectionDeclarations.flatMap((declaration) =>
      isSource(declaration) ? [] : [declaration],
    );

    // Every collection that is no source is withheld by its role; the
    // snapshot-owned Moodle users, the Flows and the access tables stay
    // literal rows of the deny-list.
    expect(editorForbiddenGrants.map(({ collection }) => collection)).toEqual([
      'moodle_users',
      ...withheld.map(({ collection }) => collection),
      'directus_flows',
      'directus_operations',
      'directus_permissions',
      'directus_policies',
      'directus_access',
    ]);

    for (const { collection, role } of withheld) {
      expect(
        editorForbiddenGrants.find((grant) => grant.collection === collection)
          ?.actions,
      ).toEqual(forbiddenByRole[role]);
    }
    for (const { collection, editorWrites } of sourceDeclarations) {
      expect(
        forbiddenGrantsIn([{ action: 'update', collection }]).length > 0,
      ).toBe(editorWrites === false);
    }

    expect(
      forbiddenGrantsIn([
        { action: 'read', collection: 'moodle_users' },
        { action: 'create', collection: 'moodle_users' },
        { action: 'update', collection: 'moodle_users' },
        { action: 'read', collection: 'course_enrollments' },
        { action: 'update', collection: 'course_enrollments' },
        { action: 'update', collection: 'moodle_course_mappings' },
        { action: 'create', collection: 'courses' },
        { action: 'read', collection: 'data_operations' },
        // A Flow operation edited to write with $full on the schedule, a
        // ledger step marked done, or a permission granted to oneself
        // would each bypass the rules above; reading Flows (the manual
        // buttons need it) stays allowed.
        { action: 'read', collection: 'directus_flows' },
        { action: 'update', collection: 'directus_operations' },
        { action: 'create', collection: 'directus_flows' },
        { action: 'update', collection: 'migration_ledger' },
        { action: 'create', collection: 'directus_permissions' },
        { action: 'update', collection: 'directus_access' },
      ]),
    ).toEqual([
      { action: 'create', collection: 'moodle_users' },
      { action: 'update', collection: 'moodle_users' },
      { action: 'update', collection: 'course_enrollments' },
      { action: 'read', collection: 'data_operations' },
      { action: 'update', collection: 'directus_operations' },
      { action: 'create', collection: 'directus_flows' },
      { action: 'update', collection: 'migration_ledger' },
      { action: 'create', collection: 'directus_permissions' },
      { action: 'update', collection: 'directus_access' },
    ]);
  });

  test('flags active Moodle users edited outside the snapshot workflow and a failed import', async () => {
    const report = {
      active: { fingerprint: 'b', rows: 30 },
      activeMatchesPromotion: false,
      promoted: { at: null, fingerprint: 'a', rows: 31 },
      state: 'completed',
    };

    const [edited, ...others] = snapshotReadiness(report);

    expect(others).toEqual([]);
    expect(edited?.code).toBe('active_snapshot_edited');
    expect(edited?.message).toContain(
      'The active Moodle users (30 rows) no longer equal the snapshot the last promotion made active (31 rows)',
    );
    expect(
      snapshotReadiness({
        ...report,
        activeMatchesPromotion: null,
        promoted: null,
      }),
    ).toEqual([]);
    expect(
      snapshotReadiness({
        ...report,
        activeMatchesPromotion: true,
        state: 'failed',
      }).map(({ code }) => code),
    ).toEqual(['snapshot_import_failed']);
    expect(() => snapshotReadiness({ state: 'completed' })).toThrow(z.ZodError);

    const paths: string[] = [];
    const request: DirectusRequest = async (pathname) => {
      paths.push(pathname);
      return report;
    };

    await expect(readSnapshotReadiness(request)).resolves.toHaveLength(1);
    expect(paths).toEqual(['/finki-hub-data-operations/snapshot']);
  });
});

describe('Mark pending', () => {
  test('is an administrator-only manual Flow on data_operations that marks and never runs', () => {
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
      key: 'admin_only',
      options: { filter: { $accountability: { admin: { _eq: true } } } },
      type: 'condition',
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
