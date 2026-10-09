import { describe, expect, test } from 'vitest';

import type { ModelCollectionKey } from '../src/schema.js';

import { declarationOf } from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import { countedLineSources } from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { schemaConstraints } from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { sourceInvalidationSql } from '../directus/extensions/directus-extension-data-operations/src/source-invalidation-sql.js';
import { registerWriteGuards } from '../directus/extensions/directus-extension-data-operations/src/write-guard.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import { collectionPlacements } from '../src/data-model/presentation/navigation.js';
import {
  aliasesFor,
  compositeKeys,
  findModelRelation,
  relationsOf,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { findCollection, findField } from './data-model-test-helpers.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';
import { fakeItemsDirectus } from './store-test-helpers.js';

// The counted lines (what each count run counted per course and year) and
// the staged matches (what it matched per page): hidden tables only the
// count run writes, and every course counted in every year.

const counted = 'moodle_counted_lines';
const matches = 'data_operation_matches';

// Each field's shape, as a row of the comparisons below.
const shapeOf = (collection: string) =>
  findCollection(collection).fields.map((field) => ({
    field: field.field,
    kind: field.kind,
    nullable: field.nullable,
    readOnly: field.readOnly === true,
    ...(field.kind === 'm2o' && {
      onDelete: field.onDelete,
      related: field.related,
    }),
  }));

const countedAliasOf = (owner: ModelCollectionKey) =>
  aliasesFor(owner).find(({ relation }) => relation.collection === counted)
    ?.alias;

describe('the counted lines', () => {
  test('hold a line, a course, a year, the source and an optional pattern mapping, all written by the count', () => {
    expect(shapeOf(counted)).toEqual([
      {
        field: 'entry',
        kind: 'm2o',
        nullable: false,
        onDelete: 'CASCADE',
        readOnly: true,
        related: 'moodle_course_entries',
      },
      {
        field: 'course',
        kind: 'm2o',
        nullable: false,
        onDelete: 'CASCADE',
        readOnly: true,
        related: 'courses',
      },
      {
        field: 'academic_year',
        kind: 'm2o',
        nullable: false,
        onDelete: 'CASCADE',
        readOnly: true,
        related: 'academic_years',
      },
      { field: 'source', kind: 'enum', nullable: false, readOnly: true },
      // Empty for an explicit mapping; a deleted mapping takes its lines.
      {
        field: 'pattern_mapping',
        kind: 'm2o',
        nullable: true,
        onDelete: 'CASCADE',
        readOnly: true,
        related: 'moodle_pattern_mappings',
      },
    ]);
    expect(findCollection(counted)).toMatchObject({
      hidden: true,
      label: { plural: 'Counted lines', singular: 'Counted line' },
    });
    expect(findField(counted, 'source')).toMatchObject({
      choices: [
        { label: 'Explicit mapping', value: 'explicit' },
        { label: 'Pattern mapping', value: 'pattern' },
      ],
    });
    expect(countedLineSources).toEqual(['explicit', 'pattern']);

    const mapping = findModelRelation(counted, 'pattern_mapping');

    expect(
      mapping === undefined ? null : toRelationPayload(mapping),
    ).toMatchObject({
      field: 'pattern_mapping',
      meta: { one_deselect_action: 'delete', one_field: 'counted_lines' },
      schema: { on_delete: 'CASCADE' },
    });
  });

  test('show read-only on a history line, a course and a pattern mapping, under their labels', () => {
    expect(
      (
        [
          'moodle_course_entries',
          'courses',
          'moodle_pattern_mappings',
          'academic_years',
        ] as const
      ).map((owner) => {
        const alias = countedAliasOf(owner);
        return (
          alias && {
            field: alias.field,
            fields: alias.fields,
            label: alias.label,
            readOnly: alias.readOnly,
          }
        );
      }),
    ).toEqual([
      {
        field: 'counted_for',
        fields: ['course', 'academic_year', 'source'],
        label: 'Counted for',
        readOnly: true,
      },
      {
        field: 'counted_lines',
        fields: ['entry', 'academic_year', 'source'],
        label: 'Counted lines',
        readOnly: true,
      },
      {
        field: 'counted_lines',
        fields: ['entry', 'academic_year'],
        label: 'Lines it counts',
        readOnly: true,
      },
      undefined,
    ]);

    const lines = countedAliasOf('moodle_pattern_mappings');

    expect(lines && toAliasPayload(lines, 5).meta).toMatchObject({
      readonly: true,
      translations: [{ language: 'en-US', translation: 'Lines it counts' }],
    });
  });

  test("follow a course's counts on its form, and stay out of the sidebar", () => {
    expect(
      fieldGroups.find(
        (group) =>
          group.collection === 'courses' && group.field === 'enrollment',
      )?.members,
    ).toEqual(['enrollments', 'counted_lines']);
    expect(effectiveFieldMeta('courses', 'counted_lines')).toMatchObject({
      group: 'enrollment',
      readonly: true,
    });
    expect(
      collectionPlacements
        .filter(
          ({ collection }) => collection === counted || collection === matches,
        )
        .map(({ collection, meta }) => `${meta.group}: ${collection}`),
    ).toEqual([`moodle: ${counted}`, `operations: ${matches}`]);
  });
});

describe('the staged matches', () => {
  test('hold a claim, a page, a line, its pattern mapping and the year read, hidden as match candidates', () => {
    expect(shapeOf(matches)).toEqual([
      { field: 'claim_token', kind: 'string', nullable: false, readOnly: true },
      { field: 'page_token', kind: 'string', nullable: false, readOnly: true },
      {
        field: 'entry',
        kind: 'm2o',
        nullable: false,
        onDelete: 'CASCADE',
        readOnly: true,
        related: 'moodle_course_entries',
      },
      {
        field: 'pattern_mapping',
        kind: 'm2o',
        nullable: false,
        onDelete: 'CASCADE',
        readOnly: true,
        related: 'moodle_pattern_mappings',
      },
      // Empty for an only-in-year mapping.
      { field: 'year_label', kind: 'string', nullable: true, readOnly: true },
    ]);
    expect(findCollection(matches)).toMatchObject({ hidden: true });
    expect(findCollection(matches).label).toEqual({
      plural: 'Match candidates',
      singular: 'Match candidate',
    });
    expect(relationsOf(matches).map(({ alias }) => alias)).toEqual([
      null,
      null,
    ]);
  });
});

describe('the counted lines and staged matches in the database', () => {
  test('are unique per line, course, year and pattern mapping, NULLs included, and per claim, page, line and mapping', () => {
    expect(
      compositeKeys.filter(
        ({ collection }) => collection === counted || collection === matches,
      ),
    ).toEqual([
      {
        collection: counted,
        columns: ['entry', 'course', 'academic_year', 'pattern_mapping'],
        kind: 'unique',
        name: 'moodle_counted_lines_entry_course_year_mapping_unique',
        nullsNotDistinct: true,
      },
      {
        collection: matches,
        columns: ['claim_token', 'page_token', 'entry', 'pattern_mapping'],
        kind: 'unique',
        name: 'data_operation_matches_claim_page_entry_mapping_unique',
      },
    ]);
    expect(schemaConstraints.statements).toEqual(
      expect.arrayContaining([
        'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_counted_lines_entry_course_year_mapping_unique" ON "moodle_counted_lines" ("entry", "course", "academic_year", "pattern_mapping") NULLS NOT DISTINCT',
        'CREATE UNIQUE INDEX IF NOT EXISTS "data_operation_matches_claim_page_entry_mapping_unique" ON "data_operation_matches" ("claim_token", "page_token", "entry", "pattern_mapping")',
      ]),
    );
  });

  test('index the memberships by line, under the name Directus gives an indexed column', () => {
    const memberships = 'moodle_history_memberships';

    expect(
      compositeKeys.filter(
        ({ collection, kind }) =>
          collection === memberships && kind === 'index',
      ),
    ).toEqual([
      {
        collection: memberships,
        columns: ['entry'],
        kind: 'index',
        name: `${memberships}_entry_index`,
      },
    ]);
    expect(toFieldPayload(findField(memberships, 'entry'), 1).schema).toEqual({
      is_indexed: true,
      is_nullable: false,
    });
    expect(schemaConstraints.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "moodle_history_memberships_entry_index" ON "moodle_history_memberships" ("entry")',
    );
  });

  test('refuse a second equal counted line in the test store, NULLs included', async () => {
    const { request } = fakeItemsDirectus({ items: new Map([[counted, []]]) });
    const created = async (rows: readonly unknown[]): Promise<unknown> => {
      try {
        await request(`/items/${counted}`, {
          body: JSON.stringify(rows),
          method: 'POST',
        });
        return 'created';
      } catch (error) {
        return error;
      }
    };
    const explicit = {
      academic_year: 3,
      course: 1,
      entry: 7,
      pattern_mapping: null,
      source: 'explicit',
    };
    const pattern = { ...explicit, pattern_mapping: 4, source: 'pattern' };

    await expect(
      created([explicit, pattern, { ...pattern, pattern_mapping: 5 }]),
    ).resolves.toBe('created');

    for (const again of [explicit, pattern]) {
      await expect(created([again])).resolves.toMatchObject({
        code: 'RECORD_NOT_UNIQUE',
        status: 400,
      });
    }
  });

  test('are written by the enrollments completion and the coordinator only, and carry no invalidation trigger', () => {
    expect([declarationOf(counted), declarationOf(matches)]).toEqual([
      {
        collection: counted,
        guard: {
          hint: 'Source: moodle_course_entries, moodle_pattern_mappings, moodle_course_mappings; rebuilt by: Data / Process pending',
          writer: 'enrollments_writer',
          writtenBy: 'enrollments claim completion',
        },
        role: 'derived',
      },
      {
        collection: matches,
        guard: {
          hint: 'Written by: coordinator',
          writer: 'candidate_writer',
          writtenBy: 'coordinator',
        },
        role: 'candidate',
      },
    ]);

    for (const table of [counted, matches]) {
      expect(sourceInvalidationSql).not.toContain(`ON "${table}"`);
    }

    const handlers = new Map<string, () => never>();
    registerWriteGuards((event, handler) => {
      handlers.set(event, handler);
    });

    for (const [table, message] of [
      [
        counted,
        'Write refused: moodle_counted_lines (derived; writer: enrollments claim completion)',
      ],
      [
        matches,
        'Write refused: data_operation_matches (candidate; writer: coordinator)',
      ],
    ] as const) {
      for (const event of ['create', 'update', 'delete']) {
        expect(() => {
          handlers.get(`${table}.items.${event}`)?.();
        }).toThrow(expect.objectContaining({ message, status: 403 }));
      }
    }
  });
});

describe('every course counted', () => {
  test('a course marks the counts and publication pending, and the counts name it as a source', () => {
    expect(declarationOf('courses')).toEqual({
      collection: 'courses',
      invalidates: ['enrollments', 'publication'],
      role: 'source',
    });
    expect(sourceInvalidationSql).toContain(
      "WHEN 'courses' THEN ARRAY['enrollments', 'publication']",
    );
    expect(declarationOf('course_enrollments')).toMatchObject({
      guard: {
        hint: 'Source: courses, moodle_pattern_mappings, moodle_course_mappings, moodle_users; rebuilt by: Data / Process pending',
      },
    });
  });
});
