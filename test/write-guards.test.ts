import { describe, expect, test } from 'vitest';

import {
  collectionDeclarations,
  type GuardedDeclaration,
  guardedDeclarations,
  isGuarded,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { openWriterSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/history-sql.js';
import { sqlPort } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import {
  guardMessage,
  openGuardSql,
  openGuardStatement,
  writeGuardStatements,
  writerSetting,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import { schemaConstraints } from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { stagingTable } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { openStagingWriterSql } from '../directus/extensions/directus-extension-data-operations/src/snapshot/sql.js';
import {
  guardedEvents,
  registerWriteGuards,
} from '../directus/extensions/directus-extension-data-operations/src/write-guard.js';

const uuid = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const guardedRoles: ReadonlySet<string> = new Set([
  'candidate',
  'derived',
  'staging',
]);
const writePattern =
  /^\s*(?:DELETE FROM|INSERT INTO|TRUNCATE|UPDATE)\s+"(?<table>[a-z_]+)"/u;
const guardTriggerPattern =
  /ON "(?<table>[a-z_]+)" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_write_guard"\('(?<setting>[a-z_.]+)'/u;

// Every statement one port call sent, answered with an empty result.
const recorded = async (
  call: (port: ReturnType<typeof sqlPort>) => Promise<unknown>,
): Promise<string[]> => {
  const sent: string[] = [];
  const port = sqlPort({
    raw: async (sql: string) => {
      sent.push(sql);
      return { rowCount: 0, rows: [] };
    },
  });
  await call(port);
  return sent;
};

const writesOf = (sent: readonly string[]): string[] =>
  sent.filter((sql) => writePattern.test(sql));

const eventsOf = ({ collection }: GuardedDeclaration): string[] =>
  guardedEvents.map((action) => `${collection}.items.${action}`);

// The guarded tables a statement list writes before opening their guard.
const unopenedWrites = (sent: readonly string[]): string[] =>
  sent.flatMap((sql, index) => {
    const table = writePattern.exec(sql)?.groups?.['table'];
    const declaration = guardedDeclarations.find(
      ({ collection }) => collection === table,
    );
    return declaration === undefined ||
      sent.slice(0, index).includes(openGuardStatement(declaration))
      ? []
      : [declaration.collection];
  });

// The guarded tables each writer setting opens: a table's trigger passes a
// statement only while the setting it names is on.
const tablesOpenedBy = (): ReadonlyMap<string, readonly string[]> => {
  const opened = new Map<string, string[]>();
  for (const trigger of writeGuardStatements().slice(1)) {
    const { setting = '', table = '' } =
      guardTriggerPattern.exec(trigger)?.groups ?? {};
    opened.set(setting, [...(opened.get(setting) ?? []), table]);
  }
  return opened;
};

// The refusal message and HINT of a guarded table.
const refusalOf = (collection: string) => {
  const declaration = guardedDeclarations.find(
    (candidate) => candidate.collection === collection,
  );
  return declaration && [guardMessage(declaration), declaration.guard.hint];
};

describe('write guards of the collection-role registry', () => {
  test('guard every derived, candidate and staging table and nothing else', () => {
    for (const declaration of collectionDeclarations) {
      expect(isGuarded(declaration)).toBe(guardedRoles.has(declaration.role));
    }

    // In registry order; the follow-up #40 tables are among them.
    expect(guardedDeclarations).toEqual(
      collectionDeclarations.filter(({ role }) => guardedRoles.has(role)),
    );
    expect(guardedDeclarations.map(({ collection }) => collection)).toEqual(
      expect.arrayContaining([
        'course_enrollments',
        'moodle_counted_lines',
        'data_operation_results',
        'data_operation_matches',
      ]),
    );

    // A writer of several tables is one writer: one name and one role.
    const writers = Map.groupBy(guardedDeclarations, writerSetting);

    for (const declarations of writers.values()) {
      expect(
        new Set(declarations.map(({ guard }) => guard.writtenBy)).size,
      ).toBe(1);
      expect(new Set(declarations.map(({ role }) => role)).size).toBe(1);
    }
  });

  test('open the counted lines and the staged matches to their own writer only', () => {
    expect(Object.fromEntries(tablesOpenedBy())).toEqual({
      'finki_hub.candidate_writer': [
        'data_operation_results',
        'data_operation_matches',
      ],
      'finki_hub.enrollments_writer': [
        'course_enrollments',
        'moodle_counted_lines',
      ],
      'finki_hub.history_writer': ['moodle_history_memberships'],
      'finki_hub.snapshot_writer': ['moodle_import_rows'],
    });
    expect(openGuardSql('moodle_counted_lines')).toBe(
      openGuardSql('course_enrollments'),
    );
    expect(openGuardSql('data_operation_matches')).toBe(
      openGuardSql('data_operation_results'),
    );
    expect(
      ['moodle_counted_lines', 'data_operation_matches'].map(refusalOf),
    ).toEqual([
      [
        'Write refused: moodle_counted_lines (derived; writer: enrollments claim completion)',
        'Source: moodle_course_entries, moodle_pattern_mappings, moodle_course_mappings; rebuilt by: Data / Process pending',
      ],
      [
        'Write refused: data_operation_matches (candidate; writer: coordinator)',
        'Written by: coordinator',
      ],
    ]);
  });

  test('install one shared function and one statement trigger per guarded table', () => {
    const [guardFunction, ...triggers] = writeGuardStatements();

    expect(schemaConstraints.statements.slice(-triggers.length - 1)).toEqual(
      writeGuardStatements(),
    );
    expect(guardFunction).toContain(
      "IF pg_trigger_depth() < 2 AND current_setting(TG_ARGV[0], true) IS DISTINCT FROM 'on' THEN",
    );
    expect(guardFunction).toContain("ERRCODE = 'insufficient_privilege'");
    expect(triggers).toHaveLength(guardedDeclarations.length);
    expect(
      triggers.find((trigger) =>
        trigger.includes('"course_enrollments_write_guard"'),
      ),
    ).toBe(
      'CREATE OR REPLACE TRIGGER "course_enrollments_write_guard" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "course_enrollments" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_write_guard"(\'finki_hub.enrollments_writer\', \'Write refused: course_enrollments (derived; writer: enrollments claim completion)\', \'Source: courses, moodle_pattern_mappings, moodle_course_mappings, course_enrollment_rules, moodle_users; rebuilt by: Data / Process pending\')',
    );

    for (const [index, declaration] of guardedDeclarations.entries()) {
      expect(triggers[index]).toContain(
        `"${declaration.collection}_write_guard" BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${declaration.collection}"`,
      );
      expect(triggers[index]).toContain(`'${writerSetting(declaration)}'`);
    }
  });

  test('let each writer open only its own table for its own transaction', () => {
    expect(openGuardSql('course_enrollments')).toBe(
      "SELECT set_config('finki_hub.enrollments_writer', 'on', true)",
    );
    expect(openWriterSql).toBe(openGuardSql('moodle_history_memberships'));
    expect(openStagingWriterSql).toBe(openGuardSql(stagingTable));
  });

  test('are opened by the coordinator before every candidate and count write', async () => {
    const calls = [
      await recorded((port) => port.discardCandidates(uuid)),
      await recorded((port) => port.discardCandidates(uuid, 'p0001')),
      await recorded((port) =>
        port.insertCandidates({
          page: 'p0001',
          revision: 3,
          rows: [{ academic_year: 1, count: 2, course: 1 }],
          token: uuid,
        }),
      ),
      await recorded((port) => port.installEnrollments(uuid, 3)),
    ];

    expect(calls.map(writesOf)).toEqual([
      [expect.stringContaining('DELETE FROM "data_operation_results"')],
      [expect.stringContaining('DELETE FROM "data_operation_results"')],
      [expect.stringContaining('INSERT INTO "data_operation_results"')],
      [
        'DELETE FROM "course_enrollments"',
        expect.stringContaining('INSERT INTO "course_enrollments"'),
      ],
    ]);
    expect(calls.flatMap(unopenedWrites)).toEqual([]);
    expect(unopenedWrites(['DELETE FROM "course_enrollments"'])).toEqual([
      'course_enrollments',
    ]);
  });

  test('refuse every Directus item write to a guarded table with a readable 403', () => {
    const registered: Array<{ event: string; handler: () => never }> = [];
    registerWriteGuards((event, handler) => {
      registered.push({ event, handler });
    });

    expect(registered.map(({ event }) => event)).toEqual(
      guardedDeclarations.flatMap(eventsOf),
    );

    for (const declaration of guardedDeclarations) {
      const handlers = registered.filter(({ event }) =>
        event.startsWith(`${declaration.collection}.items.`),
      );
      // The hook refuses with the database guard's own message.
      const message = guardMessage(declaration);

      expect(handlers).toHaveLength(3);

      for (const { handler } of handlers) {
        expect(() => handler()).toThrow(
          expect.objectContaining({
            code: 'COORDINATION_WRITE_GUARDED',
            extensions: {
              collection: declaration.collection,
              reason: 'WRITE_GUARDED',
              role: declaration.role,
            },
            message,
            status: 403,
          }),
        );
      }
    }
  });
});
