import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { ModelCollectionKey } from '../src/schema.js';

import extensionManifest from '../directus/extensions/directus-extension-data-operations/package.json' with { type: 'json' };
import { declarationOf } from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import courseDefaultMappingHook from '../directus/extensions/directus-extension-data-operations/src/course-default-mapping.js';
import { defaultYearPattern } from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  patternMappingChecks,
  patternMappingMaxBytes,
  schemaConstraints,
} from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import patternGuardHook from '../directus/extensions/directus-extension-data-operations/src/pattern-guard.js';
import { sourceInvalidationSql } from '../directus/extensions/directus-extension-data-operations/src/source-invalidation-sql.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import { folders } from '../src/data-model/presentation/navigation.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import {
  aliasesFor,
  compositeKeys,
  findModelRelation,
  modelRelations,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { findCollection, findField } from './data-model-test-helpers.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';
import { fakeItemsDirectus } from './store-test-helpers.js';

const collection = 'moodle_pattern_mappings';

// A constraint the migration adds once, by name.
const addedOnce =
  /^DO \$\$\nBEGIN\n {2}IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = '/u;

const aliasOf = (owner: ModelCollectionKey) =>
  aliasesFor(owner).find(({ relation }) => relation.collection === collection)
    ?.alias;

describe('the pattern mappings collection', () => {
  test('holds a required course and pattern, and exactly one of a year pattern and a year', () => {
    expect(
      findCollection(collection).fields.map((field) => ({
        field: field.field,
        kind: field.kind,
        nullable: field.nullable,
        ...(field.kind === 'm2o' && {
          onDelete: field.onDelete,
          related: field.related,
        }),
      })),
    ).toEqual([
      {
        field: 'course',
        kind: 'm2o',
        nullable: false,
        onDelete: 'CASCADE',
        related: 'courses',
      },
      { field: 'pattern', kind: 'text', nullable: false },
      { field: 'year_pattern', kind: 'text', nullable: true },
      // Deleting the year deletes the mappings only that year has.
      {
        field: 'only_in_year',
        kind: 'm2o',
        nullable: true,
        onDelete: 'CASCADE',
        related: 'academic_years',
      },
    ]);
    expect(findCollection(collection)).toMatchObject({
      hidden: false,
      label: { plural: 'Moodle patterns', singular: 'Moodle pattern' },
    });
  });

  test('prefills a new row with the default year pattern, which Studio requires only without a year', () => {
    expect(
      toFieldPayload(findField(collection, 'year_pattern'), 3),
    ).toMatchObject({
      meta: {
        required: false,
        translations: [{ language: 'en-US', translation: 'Year Pattern' }],
      },
      schema: { default_value: defaultYearPattern, is_nullable: true },
      type: 'text',
    });
    expect(
      effectiveFieldMeta(collection, 'year_pattern')['conditions'],
    ).toEqual([
      {
        clear_hidden_value_on_save: true,
        hidden: true,
        name: 'Only in year set',
        rule: { only_in_year: { _nnull: true } },
      },
      {
        name: 'All years',
        required: true,
        rule: { only_in_year: { _null: true } },
      },
    ]);
  });

  test('carries its short notes on its fields and on the course list', () => {
    expect(
      ['pattern', 'year_pattern', 'only_in_year'].map(
        (field) => findField(collection, field).note,
      ),
    ).toEqual([
      'Regular expression tested against each Moodle course name; ^ matches the start of the name.',
      'Group start or end captures the year the academic year starts or ends, in 2 or 4 digits (2 digits mean 20xx). A line without such a year is not counted.',
      "Counts the pattern only in this year, in place of the course's all-years mappings there.",
    ]);

    const courseList = aliasOf('courses');

    expect(courseList).toMatchObject({
      field: 'pattern_mappings',
      fields: ['pattern', 'year_pattern', 'only_in_year'],
      label: 'Moodle patterns',
    });
    expect(
      courseList === undefined ? null : toAliasPayload(courseList, 1).meta.note,
    ).toBe(
      'A new course gets <name>- with the default year pattern. A renamed course keeps its mappings; a new Moodle name needs its own pattern.',
    );
    expect(aliasOf('academic_years')).toMatchObject({
      field: 'pattern_mappings',
      label: 'Moodle patterns',
    });
  });

  test("delete a mapping removed from an academic year's list, as deleting the year does", () => {
    const year = findModelRelation(collection, 'only_in_year');

    // Nullifying its year would leave neither a year nor a year pattern.
    expect(year === undefined ? null : toRelationPayload(year)).toMatchObject({
      meta: { one_deselect_action: 'delete', one_field: 'pattern_mappings' },
      related_collection: 'academic_years',
      schema: { on_delete: 'CASCADE' },
    });

    // Across the model, a list removal nullifies a link exactly where
    // deleting the other side does.
    expect(
      modelRelations
        .map(toRelationPayload)
        .filter(
          ({ meta, schema }) =>
            (meta.one_deselect_action === 'nullify') !==
            (schema.on_delete === 'SET NULL'),
        ),
    ).toEqual([]);
  });
});

describe('the pattern mappings in Studio', () => {
  test("list a course's pattern mappings before its explicit mappings, without a section note", () => {
    const moodle = fieldGroups.find(
      (group) => group.collection === 'courses' && group.field === 'moodle',
    );

    expect(moodle?.members).toEqual(['pattern_mappings', 'history_mappings']);
    expect(
      moodle === undefined ? 'no group' : Object.hasOwn(moodle, 'note'),
    ).toBe(false);
  });

  test('sit between Moodle courses and Moodle course links in the Enrollments folder', () => {
    expect(
      folders.find((folder) => folder.collection === 'folder_enrollments'),
    ).toEqual({
      collapse: 'closed',
      collection: 'folder_enrollments',
      icon: 'history_edu',
      label: 'Enrollments',
      members: [
        'academic_years',
        'course_enrollments',
        'moodle_course_entries',
        'moodle_pattern_mappings',
        'moodle_course_mappings',
        'moodle_left_uncounted',
      ],
      sort: 8,
    });
  });

  test('show the course, pattern, year pattern and year in the default view, sorted by course', () => {
    expect(
      presetDefinitions.find(
        (preset) =>
          preset.bookmark === null && preset.collection === collection,
      )?.layout_query,
    ).toMatchObject({
      tabular: {
        fields: ['course', 'pattern', 'year_pattern', 'only_in_year'],
        sort: ['course'],
      },
    });
  });
});

describe('the pattern mappings in the database', () => {
  test('are unique per course, pattern, year pattern and year, NULLs included, and indexed by course and year', () => {
    expect(
      compositeKeys
        .filter((key) => key.collection === collection && key.nullsNotDistinct)
        .map(({ name }) => name),
    ).toEqual(['moodle_pattern_mappings_course_pattern_unique']);
    expect(schemaConstraints.statements).toEqual(
      expect.arrayContaining([
        'CREATE UNIQUE INDEX IF NOT EXISTS "moodle_pattern_mappings_course_pattern_unique" ON "moodle_pattern_mappings" ("course", "pattern", "year_pattern", "only_in_year") NULLS NOT DISTINCT',
        'CREATE INDEX IF NOT EXISTS "moodle_pattern_mappings_course_only_in_year_index" ON "moodle_pattern_mappings" ("course", "only_in_year")',
      ]),
    );
  });

  test('refuse an empty or multi-line pattern or year pattern, oversized ones, and both or neither of a year pattern and a year', () => {
    expect(schemaConstraints.statements).toEqual(
      expect.arrayContaining([...patternMappingChecks]),
    );
    expect(
      patternMappingChecks.map((statement) =>
        statement.slice(statement.indexOf('ADD CONSTRAINT')),
      ),
    ).toEqual([
      String.raw`ADD CONSTRAINT "moodle_pattern_mappings_pattern_check" CHECK ("pattern" <> '' AND "pattern" !~ '[\r\n]' AND octet_length("pattern") <= 2048);
  END IF;
END
$$`,
      `ADD CONSTRAINT "moodle_pattern_mappings_year_choice_check" CHECK (("year_pattern" IS NULL) <> ("only_in_year" IS NULL));
  END IF;
END
$$`,
      String.raw`ADD CONSTRAINT "moodle_pattern_mappings_year_pattern_check" CHECK ("year_pattern" IS NULL OR ("year_pattern" <> '' AND "year_pattern" !~ '[\r\n]' AND octet_length("year_pattern") <= 512));
  END IF;
END
$$`,
    ]);

    for (const statement of patternMappingChecks) {
      expect(statement).toMatch(addedOnce);
    }

    expect(patternMappingMaxBytes).toEqual({
      pattern: 2_048,
      year_pattern: 512,
    });
  });

  test('refuse a second equal mapping in the test store as they do, NULLs included', async () => {
    const { request } = fakeItemsDirectus({
      items: new Map([[collection, []]]),
    });
    const created = async (rows: readonly unknown[]): Promise<unknown> => {
      try {
        await request(`/items/${collection}`, {
          body: JSON.stringify(rows),
          method: 'POST',
        });
        return 'created';
      } catch (error) {
        return error;
      }
    };
    const allYears = {
      course: 1,
      only_in_year: null,
      pattern: 'Алфа-',
      year_pattern: defaultYearPattern,
    };
    const inYear = { ...allYears, only_in_year: 3, year_pattern: null };

    await expect(
      created([allYears, inYear, { ...inYear, only_in_year: 4 }]),
    ).resolves.toBe('created');

    for (const again of [
      allYears,
      inYear,
      { course: 1, pattern: 'Алфа-', year_pattern: defaultYearPattern },
    ]) {
      await expect(created([again])).resolves.toMatchObject({
        code: 'RECORD_NOT_UNIQUE',
        status: 400,
      });
    }
  });

  test('are a source: every statement marks the counts pending', () => {
    expect(declarationOf(collection)).toEqual({
      collection,
      invalidates: ['enrollments'],
      role: 'source',
    });
    // The counts are the default domain: no arm of its own.
    expect(sourceInvalidationSql).not.toContain(
      "WHEN 'moodle_pattern_mappings'",
    );
    expect(sourceInvalidationSql).toContain(
      'AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "moodle_pattern_mappings" FOR EACH STATEMENT',
    );
  });
});

describe('the pattern mapping hooks', () => {
  const entry = z.object({
    name: z.string(),
    source: z.unknown(),
    type: z.string(),
  });

  test('ship in the bundle beside the write guard, each from the module tested here', async () => {
    const hooks = z
      .object({
        'directus:extension': z.object({ entries: z.array(entry) }),
      })
      .parse(extensionManifest)
      ['directus:extension'].entries.flatMap(({ name, source, type }) =>
        type === 'hook' && typeof source === 'string' ? [{ name, source }] : [],
      );

    expect(hooks).toEqual(
      expect.arrayContaining([
        { name: 'finki-hub-write-guard', source: 'src/write-guard.ts' },
        { name: 'finki-hub-pattern-guard', source: 'src/pattern-guard.ts' },
        {
          name: 'finki-hub-course-default-mapping',
          source: 'src/course-default-mapping.ts',
        },
      ]),
    );

    for (const [source, hook] of [
      ['src/pattern-guard.ts', patternGuardHook],
      ['src/course-default-mapping.ts', courseDefaultMappingHook],
    ] as const) {
      const loaded: unknown = await import(
        new URL(
          `../directus/extensions/directus-extension-data-operations/${source}`,
          import.meta.url,
        ).href
      );

      expect(z.object({ default: z.unknown() }).parse(loaded).default).toBe(
        hook,
      );
    }
  });
});
