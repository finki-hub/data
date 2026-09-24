import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { guardedDeclarations } from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { writeGuardStatements } from '../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import { curriculumGuardStatements } from '../directus/extensions/directus-extension-data-operations/src/curriculum-guards.js';
import {
  executeMigration,
  isAdminRequest,
} from '../directus/extensions/directus-extension-data-operations/src/index.js';
import { keyGuardStatements } from '../directus/extensions/directus-extension-data-operations/src/key-guards.js';
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
import { SchemaRefusalError } from '../src/data-model/install.js';
import {
  type DirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';
import { IncompleteFlowError } from '../src/flows/install-flows.js';
import { exitCodes } from '../src/lifecycle.js';
import { loadSetupConfig, SetupConfigError } from '../src/setup-config.js';
import { runSetupCli } from '../src/setup-run.js';

const missingUrlPattern = /DIRECTUS_URL is not set/u;
const missingTokenPattern = /DIRECTUS_TOKEN/u;
const absoluteUrlPattern = /not an absolute URL/u;
const protocolPattern = /http or https/u;
const buildPattern = /npm run build:operations/u;
const restartPattern = /restart the Directus container/u;
const refusedTargetPattern =
  /^Setup refused: DIRECTUS_URL is not set\. Setup never assumes a default project and does not read \.env/u;
const refusedFlowPattern =
  /^Setup refused: The Flow "Synthetic" \(synthetic-flow\) exists without its entry operation/u;

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

    // Eleven keys and indexes, a function and a trigger per curriculum
    // generation guard and per key guard, then the write guards of the
    // collection-role registry: one shared function and a statement
    // trigger per derived, candidate and staging table.
    const rowGuards = [...curriculumGuardStatements(), ...keyGuardStatements()];
    const fixed = 11 + rowGuards.length;

    expect(count).toBe(fixed + writeGuardStatements().length);
    expect(executed.slice(11, fixed)).toEqual(rowGuards);
    expect(executed.slice(fixed)).toEqual([...writeGuardStatements()]);

    const guardTriggers = executed.slice(fixed + 1);

    expect(guardTriggers).toHaveLength(guardedDeclarations.length);

    for (const [index, { collection }] of guardedDeclarations.entries()) {
      expect(guardTriggers[index]).toContain(
        `CREATE OR REPLACE TRIGGER "${collection}_write_guard" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${collection}"`,
      );
    }

    expect(executed[fixed]).toContain(
      "pg_trigger_depth() < 2 AND current_setting(TG_ARGV[0], true) IS DISTINCT FROM 'on'",
    );
  });
});

// A request the setup stand-in never needs to answer.
const idleRequest: DirectusRequest = () => Promise.resolve(null);

// The command over a setup stand-in that answers `outcome` (or throws
// it); `requests` counts every request the command created.
const command = (outcome: () => Promise<unknown>) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests = { created: 0 };
  return {
    requests,
    run: (environment: Readonly<Record<string, string | undefined>>) =>
      runSetupCli(environment, {
        createRequest: () => {
          requests.created += 1;
          return idleRequest;
        },
        setup: outcome,
        stderr: (line) => {
          stderr.push(line);
        },
        stdout: (line) => {
          stdout.push(line);
        },
      }),
    stderr,
    stdout,
  };
};

describe('setup command', () => {
  const target = {
    DIRECTUS_TOKEN: 'synthetic-setup-token',
    DIRECTUS_URL: 'http://127.0.0.1:18055',
  };
  const counts = { adopted: 0, created: 0, refused: 1, skipped: 0 };
  const refusedSummary = {
    collections: counts,
    fields: { ...counts, aligned: 0 },
    relations: counts,
  };

  test('prints the summary and exits 0', async () => {
    const run = command(() => Promise.resolve({ flows: { created: [] } }));

    await expect(run.run(target)).resolves.toBe(exitCodes.ok);
    expect(JSON.parse(run.stdout.join('\n'))).toEqual({
      flows: { created: [] },
    });
    expect(run.stderr).toEqual([]);
  });

  test('refuses without an explicit target with exit code 2 and no request', async () => {
    const run = command(() => Promise.resolve({}));

    await expect(
      run.run({ DIRECTUS_TOKEN: target.DIRECTUS_TOKEN }),
    ).resolves.toBe(exitCodes.refused);
    expect(run.stderr).toHaveLength(1);
    expect(run.stderr[0]).toMatch(refusedTargetPattern);
    expect(run.requests.created).toBe(0);
    expect(run.stdout).toEqual([]);
  });

  test('refuses a half-installed Flow with exit code 2', async () => {
    const run = command(() =>
      Promise.reject(
        new IncompleteFlowError({ id: 'synthetic-flow', name: 'Synthetic' }),
      ),
    );

    await expect(run.run(target)).resolves.toBe(exitCodes.refused);
    expect(run.stderr[0]).toMatch(refusedFlowPattern);
  });

  test('refuses definitions the model cannot adopt with exit code 2, printing the plan summary', async () => {
    const run = command(() =>
      Promise.reject(
        new SchemaRefusalError({
          collections: [],
          fields: [],
          refusals: [
            {
              collection: 'courses',
              field: 'name',
              reason: 'synthetic incompatible column',
            },
          ],
          relations: [],
          summary: refusedSummary,
        }),
      ),
    );

    await expect(run.run(target)).resolves.toBe(exitCodes.refused);
    expect(JSON.parse(run.stdout.join('\n'))).toEqual(refusedSummary);
    expect(run.stderr[0]).toContain(
      'Setup refused: Refusing to install the data model over incompatible existing definitions:\n- synthetic incompatible column',
    );
  });

  test('fails any other error with exit code 1', async () => {
    const run = command(() => Promise.reject(new Error('synthetic outage')));

    await expect(run.run(target)).resolves.toBe(exitCodes.failed);
    expect(run.stderr).toEqual(['Setup failed: synthetic outage']);
    expect(run.stdout).toEqual([]);
  });
});
