import { describe, expect, test } from 'vitest';

import { curriculumGuardStatements } from '../directus/extensions/directus-extension-data-operations/src/curriculum-guards.js';
import { codeLevel } from '../directus/extensions/directus-extension-data-operations/src/exports/curriculum-code.js';
import { findCollection, findField } from './data-model-test-helpers.js';

// The curriculum level is the digit after `F<yy>L` at the start of the
// entry code, declared once in codeLevel; the database guard states the
// same start in SQL, and both are pinned on the same codes here.

const withLevel = [
  ['F18L3W055', 3],
  ['F18L3S07', 3],
  ['F23L1W001', 1],
  ['F18L3S162', 3],
  ['F28L1S001', 1],
  ['F23L2W002 ', 2],
] as const;

const withoutLevel = [
  'f18L3W055',
  'F8L3',
  'XF18L3',
  'F18-L3',
  'SYN23-001',
  ' F18L3W055',
  'F18L',
  'F18LXW055',
] as const;

const guardSql = curriculumGuardStatements().join('\n');

// The regular expression the guard tests a code against, as its text.
const guardPattern =
  /IF COALESCE\(NEW\."code", ''\) <> '' AND NEW\."code" !~ '(?<pattern>[^']+)' THEN/u.exec(
    guardSql,
  )?.groups?.['pattern'] ?? '';

describe('codeLevel', () => {
  test.each(withLevel)('reads level %j from %s', (code, level) => {
    expect(codeLevel(code)).toBe(level);
  });

  test.each(withoutLevel)('gives no level for %j', (code) => {
    expect(codeLevel(code)).toBeNull();
  });

  test('gives no level for a missing or empty code', () => {
    expect([codeLevel(null), codeLevel(undefined), codeLevel('')]).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('the curriculum entry code guard', () => {
  test('refuses on insert and on an update of the code, with the place-first message', () => {
    expect(guardSql).toContain(
      'CREATE OR REPLACE TRIGGER "curriculum_entries_code_guard" BEFORE INSERT OR UPDATE OF "code" ON "curriculum_entries"',
    );
    expect(guardSql).toContain(
      "RAISE EXCEPTION 'curriculum_entries.code has no level: expected F<yy>L<level>'",
    );
    expect(guardSql).toContain(
      `DETAIL = 'Key (code)=(' || COALESCE(NEW."code"::text, 'NULL') || '): ' || 'entry ' || COALESCE(NEW."id"::text, 'NULL');`,
    );
  });

  test('tests the start codeLevel reads: every code with a level passes, every other one is refused', () => {
    const start = new RegExp(guardPattern, 'u');

    expect(guardPattern).toBe('^F[0-9]{2}L[0-9]');
    expect(
      [...withLevel.map(([code]) => code), ...withoutLevel].map((code) => [
        code,
        start.test(code),
      ]),
    ).toEqual(
      [...withLevel.map(([code]) => code), ...withoutLevel].map((code) => [
        code,
        codeLevel(code) !== null,
      ]),
    );
  });
});

describe('the curriculum entry model', () => {
  test('keeps the code with its note and has no level field', () => {
    expect(
      findCollection('curriculum_entries').fields.map(({ field }) => field),
    ).not.toContain('level');
    expect(findField('curriculum_entries', 'code')).toMatchObject({
      kind: 'string',
      note: 'The digit after L is the level: F18L3W055 is level 3.',
      nullable: true,
    });
  });
});
