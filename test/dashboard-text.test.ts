import { describe, expect, test } from 'vitest';

import type { StatusView } from '../directus/extensions/directus-extension-data-operations/src/status-contract.js';

import {
  importStates,
  publicationStates,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { unknownMigrationText } from '../directus/extensions/directus-extension-data-operations/src/index.js';
import { managedFlowNote } from '../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import { readFailureText } from '../directus/extensions/directus-extension-data-operations/src/panel-answers.js';
import { decideAccess } from '../directus/extensions/directus-extension-data-operations/src/status-endpoint.js';
import {
  claimText,
  lastErrorText,
  publicationText,
  readinessText,
  toolbarText,
  waitsForText,
} from '../directus/extensions/directus-extension-data-operations/src/status-facts.js';
import { stateLabel } from '../directus/extensions/directus-extension-data-operations/src/status-labels.js';
import {
  importChoices,
  publicationChoices,
} from '../src/data-model/operations-vocabularies.js';

// The texts of the dashboard, its status endpoint and the readiness
// tooltips: one wording per situation, facts as `Label: value`, no advice.

const claim = {
  domain: 'history_index',
  heartbeatAt: null,
  label: 'Moodle history index',
  stale: false,
  startedAt: '2026-09-24T16:20:01.123Z',
};

const lastError = {
  at: '2026-09-24T16:20:01.123Z',
  blocking: true,
  code: 'PUBLICATION_FAILED',
  domain: 'publication',
  message: null,
  retries: 1,
  revision: 42,
};

// A trailing period, a Flow instruction or an internal task reference.
const adviceOrPeriod = /\.$|Data \/ (?:Add|Mark|Process)|follow-up/u;

describe('a failed read of a dashboard panel', () => {
  test('is refused for the caller and failed otherwise, with the server message only', () => {
    expect(
      readFailureText('Data status', {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
        status: 401,
      }),
    ).toBe('Data status read refused: UNAUTHENTICATED');
    expect(
      readFailureText('Flow', {
        code: 'FORBIDDEN',
        message: 'You do not have permission to access this.',
        status: 403,
      }),
    ).toBe('Flow read refused: FORBIDDEN');
    expect(
      readFailureText('Readiness checks', {
        code: 'NO_ANSWER',
        message: 'No response from Directus',
        status: null,
      }),
    ).toBe('Readiness checks read failed: NO_ANSWER');
    expect(
      readFailureText('Data status', {
        code: 'HTTP_502',
        message: '',
        status: 502,
      }),
    ).toBe('Data status read failed: HTTP_502');
    expect(
      readFailureText('Data status', {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
        status: 500,
      }),
    ).toBe(
      'Data status read failed: INTERNAL_SERVER_ERROR: An unexpected error occurred.',
    );
  });
});

describe('the status fact lines', () => {
  test('name the revisions and each scheduled Flow in the toolbar', () => {
    const schedule = [
      {
        active: true,
        ageSeconds: 12,
        id: 'f1',
        lastRunAt: '2026-09-24T16:20:01.123Z',
        name: 'Data / Process pending',
      },
      {
        active: false,
        ageSeconds: null,
        id: 'f2',
        lastRunAt: null,
        name: 'Data / Other schedule',
      },
    ];

    expect(
      toolbarText({
        revisions: { completed: 41, requested: 42, source: 42 },
        schedule,
      } as const satisfies Pick<StatusView, 'revisions' | 'schedule'>),
    ).toBe(
      'Source revision: 42 · Completed revision: 41 · Data / Process pending: 12 s ago · Data / Other schedule: no run in 60 min (inactive)',
    );
  });

  test('name domains by their labels and mark a stale claim once', () => {
    expect(waitsForText([])).toBe('');
    expect(waitsForText(['history_index', 'enrollments'])).toBe(
      'Waits for: Moodle history index, Enrollment counts',
    );
    expect(claimText(claim)).toBe(
      'Running: Moodle history index since 2026-09-24 16:20:01 UTC',
    );
    expect(claimText({ ...claim, stale: true })).toBe(
      'Running: Moodle history index since 2026-09-24 16:20:01 UTC (stale)',
    );
  });

  test('state the last publication, the last failure and the readiness summary as facts', () => {
    const files: StatusView['publication']['files'] = [];

    expect(
      publicationText({ complete: true, files, lastRevision: 42, state: 'x' }),
    ).toBe('Last publication: revision 42 (complete)');
    expect(
      publicationText({ complete: false, files, lastRevision: 42, state: 'x' }),
    ).toBe('Last publication: revision 42 (incomplete)');
    expect(
      publicationText({
        complete: false,
        files,
        lastRevision: null,
        state: 'x',
      }),
    ).toBe('Last publication: none');
    expect(lastErrorText(lastError)).toBe(
      'Domain: Publication · Revision: 42 · At: 2026-09-24 16:20:01 UTC · Retries: 1',
    );
    expect(
      lastErrorText({ ...lastError, domain: null, retries: 0, revision: null }),
    ).toBe('Domain: unknown · Revision: -- · At: 2026-09-24 16:20:01 UTC');

    const readiness = {
      blockedFiles: [],
      checks: [],
      ready: true,
      revision: 42,
    } as const;

    expect(readinessText(readiness)).toBe(
      'Source revision: 42 · Held back: none',
    );
    expect(
      readinessText({ ...readiness, blockedFiles: ['courses.json'] }),
    ).toBe('Source revision: 42 · Held back: courses.json');
  });

  test('give each stored state the label Studio shows for it', () => {
    for (const [values, choices] of [
      [importStates, importChoices],
      [publicationStates, publicationChoices],
    ] as const) {
      expect(choices.map(({ label }) => label)).toEqual(
        values.map((value) => stateLabel(value)),
      );
    }

    expect(stateLabel('ready')).toBe('Staged');
  });
});

describe('the status endpoint and the migrations endpoint', () => {
  test('refuse with the bare state or the rule, never a remedy', () => {
    const user = { admin: false, role: 'r1', roles: ['r1'], user: 'u1' };

    expect(decideAccess({})).toMatchObject({
      message: 'Authentication required',
    });
    expect(decideAccess({ accountability: user })).toMatchObject({
      message: 'Only administrators may read the data status',
    });
    expect(unknownMigrationText('foo')).toBe(
      'Unknown migration: foo; available: schema-constraints, source-invalidation',
    );
    expect(unknownMigrationText('../etc')).toBe(
      'Unknown migration; available: schema-constraints, source-invalidation',
    );
  });
});

describe('the readiness tooltips and the Run panel option', () => {
  test('state a short fact per check, without a Flow instruction or a trailing period', () => {
    const described = new Map(
      readinessRegistry.map(({ code, description }) => [code, description]),
    );

    expect(described.get('history_index_failed')).toBe(
      'Moodle history index failed: derived rows behind the source revision',
    );
    expect(described.get('academic_year_unsorted')).toBe(
      'Published academic year without a sort; keys unplaced in courses.json',
    );
    expect(described.get('study_program_sort_shared')).toBe(
      'Published study programs sharing a sort within a generation; key order undefined in courses.json',
    );
    expect(
      readinessRegistry.filter(({ description }) =>
        adviceOrPeriod.test(description),
      ),
    ).toEqual([]);
  });

  test('names the Flows a Run panel offers', () => {
    expect(managedFlowNote).toBe(
      'Installed manual Flow named "Data / …" or "Publish / …".',
    );
  });
});
