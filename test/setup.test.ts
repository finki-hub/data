import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  executeMigration,
  isAdminRequest,
} from '../directus/extensions/directus-extension-data-operations/src/index.js';
import {
  findMigration,
  migrations,
  schemaConstraints,
} from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import packageJson from '../package.json' with { type: 'json' };
import {
  applySchemaConstraints,
  applySourceInvalidation,
  dataOperationsEndpoint,
  DataOperationsUnavailableError,
  schemaConstraintsMigration,
  sourceInvalidationMigration,
} from '../src/data-model/constraints.js';
import { DirectusRequestError } from '../src/directus-request.js';
import { loadSetupConfig, SetupConfigError } from '../src/setup-config.js';

const missingUrlPattern = /DIRECTUS_URL is not set/u;
const missingTokenPattern = /DIRECTUS_TOKEN/u;
const absoluteUrlPattern = /not an absolute URL/u;
const protocolPattern = /http or https/u;
const buildPattern = /npm run build:operations/u;
const restartPattern = /restart the Directus container/u;

const packageScripts = z.object({ scripts: z.record(z.string(), z.string()) });

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

const endpointFailure = (status: number, code: string) =>
  new DirectusRequestError(
    `POST ${dataOperationsEndpoint}/migrations/schema-constraints returned ${status}`,
    { code, reason: null, status },
  );

describe('setup configuration', () => {
  const environment = {
    DIRECTUS_TOKEN: 'synthetic-token',
    DIRECTUS_URL: 'http://127.0.0.1:18055',
  };

  test('refuses to assume a default project', () => {
    expect(() =>
      loadSetupConfig({ DIRECTUS_TOKEN: 'synthetic-token' }),
    ).toThrow(SetupConfigError);
    expect(() =>
      loadSetupConfig({ DIRECTUS_TOKEN: 'synthetic-token', DIRECTUS_URL: ' ' }),
    ).toThrow(missingUrlPattern);
    expect(() =>
      loadSetupConfig({ DIRECTUS_URL: environment.DIRECTUS_URL }),
    ).toThrow(missingTokenPattern);
    expect(() =>
      loadSetupConfig({ ...environment, DIRECTUS_URL: 'directus.example' }),
    ).toThrow(absoluteUrlPattern);
    expect(() =>
      loadSetupConfig({ ...environment, DIRECTUS_URL: 'ftp://127.0.0.1' }),
    ).toThrow(protocolPattern);
  });

  test('never loads .env for setup, so the target must be named on the invocation', () => {
    const { scripts } = packageScripts.parse(packageJson);

    expect(scripts['setup']).toBe('node --import tsx src/setup-cli.ts');
  });

  test('accepts an explicit target with either token variable', () => {
    expect(loadSetupConfig(environment)).toEqual({
      token: 'synthetic-token',
      url: new URL('http://127.0.0.1:18055'),
    });
    expect(
      loadSetupConfig({
        DIRECTUS_ADMIN_TOKEN: 'admin-token',
        DIRECTUS_URL: environment.DIRECTUS_URL,
      }).token,
    ).toBe('admin-token');
  });
});

describe('schema constraints', () => {
  test('applies the bundled migration through the data-operations endpoint', async () => {
    const calls: Array<{
      init: Parameters<typeof fetch>[1];
      pathname: string;
    }> = [];

    const result = await applySchemaConstraints(async (pathname, init) => {
      calls.push({ init, pathname });
      return { applied: 'schema-constraints', statements: 14 };
    });

    expect(result).toEqual({ applied: 'schema-constraints', statements: 14 });
    expect(calls).toEqual([
      {
        init: { method: 'POST' },
        pathname: `${dataOperationsEndpoint}/migrations/schema-constraints`,
      },
    ]);
  });

  test('applies the source-invalidation migration through the same endpoint', async () => {
    const calls: Array<{ readonly init: unknown; readonly pathname: string }> =
      [];
    const result = await applySourceInvalidation(async (pathname, init) => {
      calls.push({ init, pathname });
      return { applied: 'source-invalidation', statements: 22 };
    });

    expect(result).toEqual({ applied: 'source-invalidation', statements: 22 });
    expect(calls).toEqual([
      {
        init: { method: 'POST' },
        pathname: `${dataOperationsEndpoint}/migrations/source-invalidation`,
      },
    ]);
  });

  test('rejects an unexpected endpoint response', async () => {
    await expect(
      applySchemaConstraints(async () => ({ ok: true })),
    ).rejects.toThrow();
  });

  test('names the remedy when the data-operations bundle is not served', async () => {
    const missing = endpointFailure(404, 'ROUTE_NOT_FOUND');
    const failure = await failureOf(
      applySchemaConstraints(async () => {
        throw missing;
      }),
    );

    expect(failure).toBeInstanceOf(DataOperationsUnavailableError);
    expect(failure instanceof Error && failure.message).toMatch(buildPattern);
    expect(failure instanceof Error && failure.message).toMatch(restartPattern);
    expect(failure instanceof Error && failure.message).toContain(
      `${dataOperationsEndpoint}/migrations/schema-constraints`,
    );
    expect(failure instanceof Error && failure.cause).toBe(missing);
  });

  test('rethrows other endpoint failures untouched', async () => {
    const forbidden = endpointFailure(403, 'FORBIDDEN');

    await expect(
      applySchemaConstraints(async () => {
        throw forbidden;
      }),
    ).rejects.toBe(forbidden);
  });

  test('runs only allowlisted migrations for administrators, one statement per call', async () => {
    expect(migrations.map(({ name }) => name)).toEqual([
      schemaConstraintsMigration,
      sourceInvalidationMigration,
    ]);
    expect(findMigration(schemaConstraintsMigration)).toBe(schemaConstraints);
    expect(findMigration('../schema-constraints')).toBeUndefined();
    expect(findMigration('Schema-Constraints')).toBeUndefined();
    expect(findMigration(undefined)).toBeUndefined();
    expect(isAdminRequest({ accountability: { admin: true } })).toBeTruthy();
    expect(
      isAdminRequest({ accountability: { admin: false, user: 'x' } }),
    ).toBe(false);
    expect(isAdminRequest({ accountability: null })).toBe(false);
    expect(isAdminRequest({})).toBe(false);

    const executed: string[] = [];
    const count = await executeMigration(
      {
        raw: async (sql: string) => {
          executed.push(sql);
        },
      },
      schemaConstraints,
    );

    expect(count).toBe(schemaConstraints.statements.length);
    expect(executed).toEqual([...schemaConstraints.statements]);
    // Twelve keys, indexes and generation guards, then the membership
    // write guard (its function and its statement trigger).
    expect(count).toBe(14);
    expect(executed.slice(12)).toEqual([
      expect.stringContaining(
        'CREATE OR REPLACE FUNCTION "finki_hub_history_membership_guard"()',
      ),
      'CREATE OR REPLACE TRIGGER "moodle_history_memberships_write_guard" BEFORE INSERT OR UPDATE OR DELETE ON "moodle_history_memberships" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_history_membership_guard"()',
    ]);
    expect(executed[12]).toContain(
      "pg_trigger_depth() < 2 AND current_setting('finki_hub.history_writer', true) IS DISTINCT FROM 'on'",
    );
  });
});
