import { describe, expect, test, vi } from 'vitest';
import { computed, type Ref } from 'vue';
import { z } from 'zod';

import type {
  DomainStatus,
  StatusReport,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import type { DirectusRequest } from '../src/directus-request.js';

import extensionManifest from '../directus/extensions/directus-extension-data-operations/package.json' with { type: 'json' };
import { coordinationDomains } from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  declaredFilenames,
  type StoredOutcome,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/outcomes.js';
import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import {
  dataStatusPanelId,
  humanize,
  isManagedFlowName,
  managedFlowFilter,
  operationsCollection,
  runOperationPanelId,
  sectionsOf,
  statusEndpointId,
  statusSections,
} from '../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import {
  answerSummary,
  refusalOf,
} from '../directus/extensions/directus-extension-data-operations/src/panel-answers.js';
import {
  flowKeyOf,
  type ManualFlow,
  missingRequired,
  retryValues,
  runPlan,
  triggerBody,
} from '../directus/extensions/directus-extension-data-operations/src/panel-contract.js';
import {
  readinessView,
  reviewBookmarks,
} from '../directus/extensions/directus-extension-data-operations/src/readiness-view.js';
import { importOptionsSchema } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import {
  domainStates,
  isBusy,
  nextReadMs,
  pollMs,
  readinessViewSchema,
  retryCapMs,
  statusViewSchema,
} from '../directus/extensions/directus-extension-data-operations/src/status-contract.js';
import {
  lastRunText,
  retriesFacts,
  snapshotText,
} from '../directus/extensions/directus-extension-data-operations/src/status-facts.js';
import {
  ageText,
  checkLinkText,
  collectionText,
  instantText,
  orderedChecks,
  stateLabel,
  toneOf,
  waitingText,
} from '../directus/extensions/directus-extension-data-operations/src/status-labels.js';
import { bookmarkKey } from '../directus/extensions/directus-extension-data-operations/src/status-reads.js';
import { statusView } from '../directus/extensions/directus-extension-data-operations/src/status-view.js';
import { useStudioName } from '../directus/extensions/directus-extension-data-operations/src/studio-name.js';
import {
  defaultPanels,
  installOperationsDashboard,
  operationsDashboardId,
} from '../src/data-model/operations-dashboard.js';
import { dashboardCode, flowFamilyCodes } from '../src/flows/flow-template.js';
import { snapshotImportFlow } from '../src/flows/snapshot-import.js';
import { flowTemplates } from './registry-test-helpers.js';

// Task 16: the generic Run operation and status panels (audit X14), their
// contract with the manual Flows and the status endpoint, and the default
// Data operations dashboard. The panels themselves render in Studio
// (test/operations.browser.mjs); here their decisions run as plain code.

// The app's collections store as useCollection reads it: the names Studio
// shows, by collection.
const studioNames = vi.hoisted(
  () => new Map([['course_equivalencies', 'Equivalencies']]),
);

vi.mock('@directus/extensions-sdk', () => ({
  useCollection: (key: Ref<null | string>) => ({
    info: computed(() => {
      const name = studioNames.get(key.value ?? '');
      return name === undefined ? null : { name };
    }),
  }),
}));

// A fixture Flow as added in Studio.
const fixtureFlow: ManualFlow = {
  description: 'Synthetic operation.',
  icon: 'bolt',
  id: '9e4d826c-0000-4000-8000-000000001600',
  name: 'Data / Synthetic operation',
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: 'Run the synthetic operation?',
    error_on_reject: true,
    fields: [
      {
        field: 'note_text',
        meta: { interface: 'input', required: true },
        type: 'string',
      },
      {
        field: 'confirm',
        meta: { interface: 'boolean' },
        name: 'Confirm it',
        type: 'boolean',
      },
    ],
    requireConfirmation: true,
    requireSelection: false,
  },
  status: 'active',
  trigger: 'manual',
};

// The run plan of the fixture Flow on the given collections.
const on = (collections: string[]) =>
  runPlan({
    ...fixtureFlow,
    options: { ...fixtureFlow.options, collections },
  });

const runnable = (flow: ManualFlow) => {
  const plan = runPlan(flow);
  if (!plan.runnable) {
    throw new Error(plan.reason);
  }
  return plan;
};

describe('the Run operation panel contract', () => {
  test('renders a fixture Flow with its own confirmation and fields', () => {
    const plan = runnable(fixtureFlow);

    expect(plan.description).toBe('Run the synthetic operation?');
    expect(plan.confirm).toBeTruthy();
    expect(plan.collection).toBe('data_operations');
    expect(plan.fields.map(({ field, name }) => [field, name])).toEqual([
      ['note_text', 'Note text'],
      ['confirm', 'Confirm it'],
    ]);
    expect(missingRequired(plan.fields, {})).toEqual(['Note text']);
    expect(missingRequired(plan.fields, { note_text: 'x' })).toEqual([]);
  });

  test('posts only the collection and the values of the declared fields', () => {
    const plan = runnable(fixtureFlow);

    expect(
      triggerBody(plan, { confirm: true, extra: 'dropped', note_text: '' }),
    ).toEqual({ collection: 'data_operations', confirm: true });
  });

  test('refuses what a panel cannot run, and says why', () => {
    const withOptions = (options: Record<string, unknown>): ManualFlow => ({
      ...fixtureFlow,
      options: { ...fixtureFlow.options, ...options },
    });
    const reasons = [
      { ...fixtureFlow, trigger: 'webhook' },
      { ...fixtureFlow, name: 'Synthetic / Other family' },
      { ...fixtureFlow, status: 'inactive' },
      withOptions({ collections: [] }),
      { ...fixtureFlow, options: { collections: ['data_operations'] } },
    ].map((flow) => runPlan(flow));

    expect(reasons).toEqual(
      [
        'trigger not manual',
        'name without a "Data / " or "Publish / " prefix',
        'Flow inactive',
        'no collection',
        'requires item selection',
      ].map((rule) => ({ reason: `Not runnable: ${rule}`, runnable: false })),
    );
  });

  test('runs a Flow only on data_operations', () => {
    expect(operationsCollection).toBe('data_operations');
    expect(on(['courses'])).toEqual({
      reason: `Not runnable: collections must be exactly ${operationsCollection}`,
      runnable: false,
    });
    expect(on([operationsCollection, 'courses']).runnable).toBe(false);
    expect(on([operationsCollection])).toMatchObject({
      collection: operationsCollection,
      runnable: true,
    });
  });

  test('runs only a Flow that reports its failures: synchronous, with Error on Reject', () => {
    const reason =
      'Not runnable: requires Asynchronous off and Error on Reject on';
    const plans = [
      { async: true },
      { async: true, error_on_reject: true },
      { error_on_reject: false },
      { error_on_reject: null },
    ].map((options) =>
      runPlan({
        ...fixtureFlow,
        options: { ...fixtureFlow.options, ...options },
      }),
    );

    expect(plans).toEqual(plans.map(() => ({ reason, runnable: false })));
    expect(runnable(fixtureFlow).runnable).toBeTruthy();
  });

  test('offers the inputs of a failed run again, less its acknowledgements', () => {
    const plan = runnable(fixtureFlow);

    expect(
      retryValues(plan.fields, {
        confirm: true,
        extra: 'dropped',
        note_text: 'again',
      }),
    ).toEqual({ note_text: 'again' });
    expect(retryValues(plan.fields, { confirm: false })).toEqual({});
  });

  test('can run every installed manual Flow template, all of a managed family', () => {
    const manual = flowTemplates().filter(
      ({ trigger }) => trigger === 'manual',
    );

    expect(manual.length).toBeGreaterThan(0);
    expect(
      manual.filter(
        (template) =>
          !isManagedFlowName(template.name) ||
          !runPlan({ ...template, status: 'active' }).runnable,
      ),
    ).toEqual([]);
    expect(managedFlowFilter._and[0]).toEqual({ trigger: { _eq: 'manual' } });
  });

  test('reads its Flow option as Studio stores it or as a plain id', () => {
    expect(flowKeyOf({ collection: 'directus_flows', key: 'f1' })).toBe('f1');
    expect(flowKeyOf('f2')).toBe('f2');
    expect(flowKeyOf({ collection: 'directus_files', key: 'x' })).toBeNull();
    expect(flowKeyOf(null)).toBeNull();
  });

  test('reads a refusal and a bounded answer, never a whole payload', () => {
    expect(
      refusalOf({
        response: {
          data: {
            errors: [
              { extensions: { code: 'FORBIDDEN' }, message: 'Forbidden' },
            ],
          },
          status: 403,
        },
      }),
    ).toEqual({ code: 'FORBIDDEN', message: 'Forbidden', status: 403 });
    expect(refusalOf(new Error('socket hang up'))).toEqual({
      code: 'NO_ANSWER',
      message: 'No response from Directus',
      status: null,
    });
    expect(refusalOf({ response: { status: 502 } })).toEqual({
      code: 'HTTP_502',
      message: '',
      status: 502,
    });
    expect(
      answerSummary({
        created: 3,
        files: { 'courses.json': {} },
        long: 'x'.repeat(700),
        rows: [1, 2],
      }),
    ).toEqual([
      { label: 'Created', text: '3' },
      { label: 'Files', text: '1 entry' },
      { label: 'Long', text: `${'x'.repeat(600)}…` },
      { label: 'Rows', text: '2 entries' },
    ]);
    expect(answerSummary(null)).toEqual([]);
  });
});

const idle: DomainStatus = {
  current: true,
  failed: false,
  pending: false,
  running: false,
  state: 'current',
  waitingFor: [],
};

const failedDomain: DomainStatus = {
  ...idle,
  current: false,
  failed: true,
  state: 'failed',
};

const uploadedAt = (revision: number): StoredOutcome => ({
  bytes: 10,
  code: null,
  outcome: 'uploaded',
  revision,
});

// The coordinator status of an idle project with one partial publication.
const report: StatusReport = {
  candidates: 0,
  claim: null,
  dirty: ['publication'],
  domains: Object.fromEntries(
    coordinationDomains.map((domain) => [
      domain,
      domain === 'publication' ? failedDomain : idle,
    ]),
  ),
  fingerprints: {
    calculation: 'c'.repeat(64),
    current: { calculation: 'c'.repeat(64), publication: 'p'.repeat(64) },
    publication: 'p'.repeat(64),
  },
  historyIndex: {
    countMismatches: 0,
    entries: 2,
    indexedUsers: 1,
    memberships: 2,
    users: 1,
  },
  importState: 'completed',
  lastError: {
    at: '2026-09-24T10:00:00.000Z',
    blocking: true,
    code: 'PUBLICATION_PARTIAL',
    domain: 'publication',
    message: 'rooms.json (PUBLISH_UPLOAD_FAILED)',
    retries: 0,
    revision: 7,
  },
  lastRun: { finishedAt: null, retries: 0, startedAt: null },
  pending: ['publication'],
  process: 'synthetic-process-owner',
  publication: {
    files: {
      'courses.json': uploadedAt(7),
      'rooms.json': {
        bytes: null,
        code: 'PUBLISH_UPLOAD_FAILED',
        outcome: 'failed',
        revision: 7,
      },
    },
    state: 'partial',
  },
  revisions: {
    completed: 6,
    inputs: { enrollments: 6, history_index: 6 },
    requested: 7,
    source: 7,
  },
  staleAfterMs: 60_000,
};

// When a panel reads the status again after the given failures.
const read = (failures: number, refused = false, busy = false) =>
  nextReadMs({ busy, failures, refused });

const viewOf = () => statusView({ keySources: [], report, schedule: [] });

describe('the status view', () => {
  test('lists every declared domain and file, with the outcome it holds', () => {
    const view = statusViewSchema.parse(viewOf());

    expect(view.domains.map(({ name }) => name)).toEqual(coordinationDomains);
    expect(view.publication.files.map(({ filename }) => filename)).toEqual(
      declaredFilenames,
    );
    expect(
      view.publication.files.map(({ filename, outcome }) => [
        filename,
        outcome,
      ]),
    ).toEqual(
      declaredFilenames.map((filename) => [
        filename,
        { 'courses.json': 'uploaded', 'rooms.json': 'failed' }[filename] ??
          null,
      ]),
    );
    expect(view.publication).toMatchObject({
      complete: false,
      lastRevision: 7,
      state: 'partial',
    });
    expect(view.lastError?.message).toBe('rooms.json (PUBLISH_UPLOAD_FAILED)');
    expect(view.lastError?.retries).toBe(0);
  });

  test('carries no token, owner, fingerprint or process', () => {
    const text = JSON.stringify(viewOf());

    for (const word of ['token', 'owner', 'fingerprint', 'process']) {
      expect(text).not.toContain(word);
    }
  });

  test('counts a publication complete only when every declared file was uploaded at its revision', () => {
    const uploaded = Object.fromEntries(
      declaredFilenames.map((filename) => [filename, uploadedAt(9)]),
    );
    const view = statusView({
      keySources: [],
      report: {
        ...report,
        publication: { files: uploaded, state: 'completed' },
      },
      schedule: [],
    });

    expect(view.publication).toMatchObject({ complete: true, lastRevision: 9 });
    expect(isBusy(view)).toBe(false);
    expect(
      isBusy({
        ...view,
        claim: {
          ...view.claim,
          domain: 'x',
          heartbeatAt: null,
          label: 'X',
          stale: false,
          startedAt: null,
        },
      }),
    ).toBeTruthy();
  });

  test('shows a failed publication that uploaded some declared files as partial', () => {
    const states = (publication: typeof report.publication) =>
      Object.fromEntries(
        statusView({
          keySources: [],
          report: { ...report, publication },
          schedule: [],
        }).domains.map(({ name, state }) => [name, state]),
      );

    expect(states(report.publication)).toMatchObject({
      enrollments: 'current',
      publication: 'partial',
    });
    expect(
      states({ files: report.publication.files, state: 'failed' }),
    ).toMatchObject({ publication: 'failed' });
    expect(statusViewSchema.parse(viewOf()).domains).toHaveLength(
      coordinationDomains.length,
    );
  });

  test('reads a failed status again with a growing pause, but not a refusal', () => {
    expect([1, 2, 3].map((failures) => read(failures))).toEqual([
      pollMs,
      pollMs * 2,
      pollMs * 4,
    ]);
    expect(read(20)).toBe(retryCapMs);
    expect(read(1, true)).toBeNull();
    expect(read(1, true, true)).toBe(pollMs);
    expect(read(0)).toBeNull();
    expect(read(0, false, true)).toBe(pollMs);
  });

  test('polls for pending calculations and running work, not for a publication that waits for the Publish button', () => {
    const view = viewOf();
    const withStates = (states: Readonly<Record<string, string>>) => ({
      ...view,
      claim: null,
      domains: view.domains.map((domain) => ({
        ...domain,
        state: z.enum(domainStates).parse(states[domain.name] ?? 'current'),
      })),
    });

    expect(isBusy(withStates({ publication: 'pending' }))).toBe(false);
    expect(isBusy(withStates({ publication: 'failed' }))).toBe(false);
    expect(isBusy(withStates({ publication: 'running' }))).toBeTruthy();
    expect(isBusy(withStates({ history_index: 'pending' }))).toBeTruthy();
    expect(isBusy(withStates({ enrollments: 'running' }))).toBeTruthy();
  });
});

describe('the readiness view', () => {
  // The checks that declare a review view.
  const reviewedCodes = new Set(
    readinessRegistry.flatMap(({ code, review }) =>
      review === undefined ? [] : [code],
    ),
  );
  const counts = new Map(
    readinessRegistry.map(({ code }, index) => [code, index % 3]),
  );
  const answer = {
    blockedFiles: ['courses.json'],
    blockers: [],
    issueCounts: Object.fromEntries(counts),
    links: {},
    ready: false,
    reviews: {},
    revision: 7,
    warnings: [],
  };

  test('has one row per declared check, in registry order, with one link each', () => {
    const view = readinessViewSchema.parse(
      readinessView({ answer, bookmarks: new Map() }),
    );

    expect(view.checks.map(({ code }) => code)).toEqual(
      readinessRegistry.map(({ code }) => code),
    );
    expect(
      view.checks.every(({ link }) => link.startsWith('/content/')),
    ).toBeTruthy();
  });

  test('links a check to its incomplete-data bookmark while it exists, named by it', () => {
    const [name] = reviewBookmarks();
    const entry = readinessRegistry.find(
      ({ review }) => review?.bookmark === name,
    );
    if (name === undefined || entry === undefined) {
      throw new Error('The registry declares no review bookmark');
    }
    const view = readinessView({
      answer,
      bookmarks: new Map([[bookmarkKey(entry.page, name), 41]]),
    });
    const check = view.checks.find(({ code }) => code === entry.code);

    expect(check).toMatchObject({
      link: `/content/${entry.page}?bookmark=41`,
      review: name,
    });
    expect(check === undefined ? null : checkLinkText(check)).toBe(name);
    expect(
      orderedChecks(view.checks).findIndex(({ count }) => count === 0),
    ).toBeGreaterThan(0);
  });

  test('links a check whose bookmark is missing or deleted to its collection, named by it', () => {
    const view = readinessView({ answer, bookmarks: new Map() });
    const reviewed = view.checks.filter(({ code }) => reviewedCodes.has(code));

    expect(reviewed.length).toBeGreaterThan(0);
    expect(
      reviewed.map(({ link, page, review }) => ({ link, page, review })),
    ).toEqual(
      reviewed.map(({ page }) => ({
        link: `/content/${page}`,
        page,
        review: null,
      })),
    );
    expect(reviewed.map((check) => checkLinkText(check))).toEqual(
      reviewed.map(({ page }) => humanize(page)),
    );
  });

  test('names a check whose bookmark is missing by the name Studio shows for its collection, else by the humanized key', () => {
    const view = readinessView({ answer, bookmarks: new Map() });
    const check = view.checks.find(
      ({ page, review }) => page === 'course_equivalencies' && review === null,
    );
    if (check === undefined) {
      throw new Error('No check links the equivalencies');
    }

    expect(checkLinkText(check, 'Equivalencies')).toBe('Equivalencies');
    expect(checkLinkText(check)).toBe('Course equivalencies');
    expect(
      checkLinkText(
        { ...check, review: 'Equivalencies without a course' },
        'Equivalencies',
      ),
    ).toBe('Equivalencies without a course');
  });
});

describe('the dashboard collection names', () => {
  test('name a collection as Studio does, else by its humanized key', () => {
    expect(collectionText('curriculum_generations', 'Generations')).toBe(
      'Generations',
    );
    expect(collectionText('curriculum_generations')).toBe(
      'Curriculum generations',
    );
  });

  test("read the Studio name from the app's collections store, none for a collection it does not list", () => {
    const listed = useStudioName(() => 'course_equivalencies');
    const unlisted = useStudioName(() => 'curriculum_generations');

    expect(listed.value).toBe('Equivalencies');
    expect(unlisted.value).toBeUndefined();
    expect(collectionText('curriculum_generations', unlisted.value)).toBe(
      'Curriculum generations',
    );
  });
});

describe('the status labels', () => {
  test('names a current domain idle and colours each state', () => {
    expect(stateLabel('current')).toBe('Idle');
    expect(stateLabel(null)).toBe('Never');
    expect(stateLabel('partial')).toBe('Partial');
    expect(
      ['current', 'pending', 'running', 'failed', 'partial', 'x'].map(toneOf),
    ).toEqual(['success', 'warning', 'info', 'danger', 'warning', 'neutral']);
    expect(instantText('2026-09-24T16:20:01.123Z')).toBe(
      '2026-09-24 16:20:01 UTC',
    );
    expect([0, 1, 2].map(retriesFacts)).toEqual([
      [],
      [['Retries', 1]],
      [['Retries', 2]],
    ]);
    expect(
      lastRunText({
        finishedAt: '2026-09-24T16:21:07.000Z',
        retries: 1,
        startedAt: '2026-09-24T16:20:01.000Z',
      }),
    ).toBe(
      'Last run: 2026-09-24 16:20:01 UTC – 2026-09-24 16:21:07 UTC · Retries: 1',
    );
    expect(lastRunText({ finishedAt: null, retries: 0, startedAt: null })).toBe(
      'Last run: --',
    );
    expect([12, 300, 9_000, null].map(ageText)).toEqual([
      '12 s',
      '5 min',
      '2 h',
      '--',
    ]);
    expect(
      ['academic_years', 'previousRows', 'membershipsRemoved'].map(humanize),
    ).toEqual(['Academic years', 'Previous rows', 'Memberships removed']);
    expect(sectionsOf(['keys', 'bogus'])).toEqual(['keys']);
    expect(sectionsOf(null)).toEqual([...statusSections]);
  });

  test('writes each Moodle snapshot count as a labelled fact', () => {
    const none = {
      countMismatches: 0,
      entries: 0,
      indexedUsers: 0,
      memberships: 0,
      users: 0,
    };

    expect(
      snapshotText({
        ...none,
        countMismatches: 1,
        entries: 1,
        indexedUsers: 1,
        users: 1,
      }),
    ).toBe(
      'Users: 1 · Indexed: 1 · History lines: 1 · Courses Count mismatches: 1',
    );
    expect(
      snapshotText({ ...none, entries: 12, indexedUsers: 2, users: 3 }),
    ).toBe(
      'Users: 3 · Indexed: 2 · History lines: 12 · Courses Count mismatches: 0',
    );
  });

  test('says what Run waits for: the claim, or a run another panel of the page started', () => {
    const claim = {
      domain: 'history_index',
      heartbeatAt: null,
      label: 'Moodle history index',
      stale: false,
      startedAt: null,
    };

    expect(waitingText(null, false)).toBeNull();
    expect(waitingText(null, true)).toBe('run in progress on this page');
    expect(waitingText(claim, false)).toBe(
      'claim held by Moodle history index',
    );
    expect(waitingText({ ...claim, stale: true }, true)).toBe(
      'claim held by Moodle history index (stale)',
    );
  });
});

// The grid columns a row of panels covers, in order, a column once per
// panel covering it.
const gridColumns = (row: ReadonlyArray<{ width: number; x: number }>) =>
  row
    .flatMap(({ width, x }) =>
      Array.from({ length: width }, (_, index) => x + index),
    )
    .toSorted((left, right) => left - right);

describe('the Data operations dashboard', () => {
  test('declares the default panels once, each for an installed manual Flow or the status', () => {
    const templates = new Map(flowTemplates().map((flow) => [flow.id, flow]));
    const flows = defaultPanels.flatMap(({ options }) => {
      const key = flowKeyOf(options['flow']);
      return key === null ? [] : [templates.get(key)?.name];
    });

    expect(flows).toEqual([
      'Publish / Public assets',
      'Data / Mark pending',
      'Data / Import Moodle snapshot',
    ]);
    expect(new Set(defaultPanels.map(({ id }) => id)).size).toBe(
      defaultPanels.length,
    );
    // The installed ids stay: the code of the retired enrollment-rules
    // family, which no Flow family carries, and the panels' suffixes.
    expect(Object.values(flowFamilyCodes)).not.toContain(dashboardCode);
    expect(operationsDashboardId).toBe('6a1d9f0e-2b3c-4d5e-8f70-0000000016d0');
    expect(defaultPanels.map(({ id }) => id.slice(-4))).toEqual([
      '16d1',
      '16d2',
      '16d3',
      '16d5',
      '16d6',
      '16d7',
    ]);
    expect(
      defaultPanels.every(({ id }) =>
        id.startsWith(operationsDashboardId.slice(0, -2)),
      ),
    ).toBeTruthy();
    expect(new Set(defaultPanels.map(({ type }) => type))).toEqual(
      new Set([dataStatusPanelId, runOperationPanelId]),
    );
    expect(
      defaultPanels.flatMap(({ options }) =>
        options['sections'] === undefined
          ? []
          : sectionsOf(options['sections']),
      ),
    ).toEqual([...statusSections]);
  });

  test('fills each panel row from column 1 to 52, without a gap or an overlap', () => {
    const full = gridColumns([{ width: 52, x: 1 }]);

    expect(
      Map.groupBy(defaultPanels, ({ y }) => y)
        .values()
        .map((row) => gridColumns(row))
        .toArray(),
    ).toEqual([full, full, full]);
  });

  test('creates what is missing and never touches what exists', async () => {
    const present = new Set<string>([defaultPanels[0]?.id ?? '']);
    const calls: Array<{ body: unknown; method: string; path: string }> = [];
    let dashboard = false;
    const request: DirectusRequest = async (path, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (path.startsWith('/dashboards')) {
          return dashboard ? [{ id: operationsDashboardId }] : [];
        }
        return [...present].map((id) => ({ id }));
      }
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ body, method, path });
      if (path === '/dashboards') {
        dashboard = true;
        return {};
      }
      const created = z.array(z.object({ id: z.string() })).parse(body);
      for (const { id } of created) {
        present.add(id);
      }
      return {};
    };

    const first = await installOperationsDashboard(request);

    expect(first.created).toEqual([
      'Data operations',
      ...defaultPanels.slice(1).map(({ name }) => name),
    ]);
    expect(first.skipped).toEqual([defaultPanels[0]?.name]);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /dashboards',
      'POST /panels',
    ]);

    calls.length = 0;
    const again = await installOperationsDashboard(request);

    expect(again.created).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('ships the panels and the status endpoint in the bundle manifest', () => {
    const entries = z
      .object({
        'directus:extension': z.object({
          entries: z.array(z.object({ name: z.string(), type: z.string() })),
        }),
      })
      .parse(extensionManifest)
      ['directus:extension'].entries.map(({ name, type }) => `${type} ${name}`);

    expect(entries).toEqual(
      expect.arrayContaining([
        `endpoint ${statusEndpointId}`,
        `panel ${runOperationPanelId}`,
        `panel ${dataStatusPanelId}`,
      ]),
    );
  });
});

describe('the snapshot Flow file field', () => {
  test('is an item picker of the private folder files, and the import takes the pick', () => {
    const file = z
      .object({
        fields: z.array(
          z.object({
            field: z.string(),
            meta: z.looseObject({ interface: z.string() }),
          }),
        ),
      })
      .parse(snapshotImportFlow.options)
      .fields.find(({ field }) => field === 'file');
    const id = '6a1d9f0e-2b3c-4d5e-8f70-0000000016fd';

    expect(file?.meta.interface).toBe('collection-item-dropdown');
    expect(file?.meta).toMatchObject({
      options: { selectedCollection: 'directus_files' },
    });
    expect(
      importOptionsSchema.parse({
        file: { collection: 'directus_files', key: id },
      }),
    ).toEqual({ file: id });
    expect(importOptionsSchema.parse({ file: id })).toEqual({ file: id });
    expect(
      importOptionsSchema.safeParse({
        file: { collection: 'courses', key: id },
      }).success,
    ).toBe(false);
  });
});
