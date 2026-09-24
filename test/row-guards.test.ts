import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { curriculumGuardStatements } from '../directus/extensions/directus-extension-data-operations/src/curriculum-guards.js';
import {
  keySources,
  optInField,
} from '../directus/extensions/directus-extension-data-operations/src/exports/key-sources.js';
import { keyGuards } from '../directus/extensions/directus-extension-data-operations/src/key-guards.js';

// The row guards the database enforces beside the curriculum generation
// matches (data-model.test.ts): the parent row locks that serialize two
// concurrent writes, and the key guards of published key rows.

// A read of one parent row inside a curriculum guard, by the id a
// dependant names.
const parentReadPattern =
  /SELECT "[a-z_]+" INTO [a-z_]+ FROM "(?<table>[a-z_]+)" WHERE "id" = NEW\."[a-z_]+"(?<lock>[^;]*);/gu;

const quotedField = /"(?<field>[a-z_]+)"/u;

const parentReads = Array.from(
  curriculumGuardStatements().join('\n').matchAll(parentReadPattern),
  ({ groups }) => [groups?.['table'], groups?.['lock']],
);

// The top-level conditions of a filter: its `_and` parts, or itself.
const conditionsOf = (filter: unknown): readonly unknown[] =>
  z.object({ _and: z.array(z.unknown()) }).safeParse(filter).data?._and ?? [
    filter,
  ];

const guardedKeys = keyGuards.map(({ events, table }) => [
  table,
  quotedField.exec(events)?.groups?.['field'],
]);

describe('the curriculum guards', () => {
  test('read each parent row FOR SHARE, so a concurrent parent update and a dependant write serialize', () => {
    expect(parentReads).toEqual([
      ['curriculum_entries', ' FOR SHARE'],
      ['curriculum_generations', ' FOR SHARE'],
      ['curriculum_entries', ' FOR SHARE'],
      ['study_programs', ' FOR SHARE'],
      ['curriculum_entries', ' FOR SHARE'],
    ]);
  });
});

describe('the key guards', () => {
  test('guard the key field of every key-source collection once, on update only', () => {
    expect(keyGuards.map(({ events, table }) => [table, events])).toEqual([
      ['curriculum_generations', 'UPDATE OF "code"'],
      ['study_programs', 'UPDATE OF "code"'],
      ['academic_years', 'UPDATE OF "label"'],
    ]);
    expect(
      Object.values(keySources).map(({ collection, key }) => [collection, key]),
    ).toEqual(guardedKeys);
  });

  test('refuse a new key text only while the row is published before and after the write', () => {
    for (const { body, table } of keyGuards) {
      expect(body).toContain(
        `IF OLD."${optInField}" IS TRUE AND NEW."${optInField}" IS TRUE AND NEW.`,
      );
      expect(body).toContain(
        `ERRCODE = 'foreign_key_violation', TABLE = '${table}'`,
      );
      expect(body).toContain("DETAIL = 'Key (");
    }
  });

  test('guard the opt-in every key source reads: the row is published', () => {
    for (const { filter } of Object.values(keySources)) {
      expect(conditionsOf(filter)).toContainEqual({
        [optInField]: { _eq: true },
      });
    }
  });
});
