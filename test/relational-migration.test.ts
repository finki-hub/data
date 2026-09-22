import { describe, expect, test } from 'vitest';

import { deriveCourses } from '../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import {
  convertCourseCurricula,
  type ExistingLink,
  linkKey,
} from '../src/migrations/course-links.js';
import {
  convertCurriculumEntries,
  entryKey,
} from '../src/migrations/curricula.js';
import {
  convertAcademicYears,
  convertEnrollmentRules,
  type ExistingRule,
  ruleKey,
  type RuleRecord,
} from '../src/migrations/rules.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
  type SyntheticDataset,
  thetaCrossNewlinePattern,
  toCourseSources,
} from './fixtures/synthetic-data.js';
import {
  codes,
  entryIdsOf,
  none,
  prepare,
  uniqueDataset,
  yearIdsOf,
} from './relational-migration-helpers.js';

const orphanLegacy = 'Orphan Legacy Course';
const noLinks: ReadonlyMap<string, ExistingLink> = new Map();
const noRules: ReadonlyMap<string, ExistingRule> = new Map();

// Every seeded rule as an explicit pattern row, one per course and year,
// so the checkpoint derivation can be run over the frozen rules.
const frozenDataset = (
  dataset: SyntheticDataset,
  rules: readonly RuleRecord[],
  labels: ReadonlyMap<number, string>,
): SyntheticDataset => {
  const names = new Map(
    dataset.courses.map((course) => [course.id, String(course['name'])]),
  );
  return {
    ...dataset,
    course_enrollment_patterns: rules.map((record, index) => ({
      id: index + 1,
      course_name: names.get(record.course) ?? '',
      academic_year: labels.get(record.academic_year) ?? '',
      pattern: record.pattern,
    })),
  };
};

describe('curriculum entries', () => {
  test('copies every 2023 and 2018 row, orphans and duplicates included, with provenance and literal values', async () => {
    const dataset = makeSyntheticDataset();
    const { checkpoint } = await prepare(dataset);

    const conversion = convertCurriculumEntries(checkpoint, none);

    expect(conversion.findings).toEqual([]);
    expect(conversion.settled).toEqual([]);
    expect(conversion.writes).toHaveLength(20);
    expect(
      conversion.writes.map(({ record }) => [
        record.source_collection,
        record.source_id,
      ]),
    ).toEqual([
      ...dataset.curriculum_2023.map((row) => ['curriculum_2023', row.id]),
      ...dataset.curriculum_2018.map((row) => ['curriculum_2018', row.id]),
    ]);

    const records = conversion.writes.map(({ record }) => record);
    const orphan = records.find(({ name }) => name === orphanLegacy);
    const zeta = records.find(
      ({ generation, name }) =>
        generation === '2023' && name === courseNames.zeta,
    );
    const epsilon = records.find(
      ({ generation, name }) =>
        generation === '2018' && name === 'Epsilon Legacy',
    );

    expect(orphan).toMatchObject({
      generation: '2018',
      code: 'SYN18-ORPHAN',
      channel: true,
      state_ie: null,
      state_ssp: null,
      source_collection: 'curriculum_2018',
      source_id: 8,
    });
    expect(zeta).toMatchObject({
      code: '',
      prerequisites: '',
      state_kn: '',
      channel: null,
      semester: 6,
      state_ke: null,
      url: 'https://curriculum.example/2023/7',
    });
    expect(epsilon).toMatchObject({
      state_ke: 'ke-legacy',
      state_ie: null,
      state_ssp: null,
      catalog_order: 5,
    });
    expect(
      conversion.writes.find(({ record }) => record.name === orphanLegacy)
        ?.mappings,
    ).toEqual([
      {
        relation: 'entry',
        sourceCollection: 'curriculum_2018',
        sourceId: 8,
        status: 'pending',
        targetCollection: 'curriculum_entries',
        targetId: null,
      },
    ]);
    expect(convertCurriculumEntries(checkpoint, none)).toEqual(conversion);
  });

  test('reuses an entry that already carries the provenance instead of planning a second row', async () => {
    const { checkpoint } = await prepare(uniqueDataset());
    const existing = new Map([[entryKey('curriculum_2023', 1), 41]]);

    const conversion = convertCurriculumEntries(checkpoint, existing);

    expect(conversion.writes).toHaveLength(17);
    expect(conversion.settled).toEqual([
      {
        relation: 'entry',
        sourceCollection: 'curriculum_2023',
        sourceId: 1,
        status: 'existing',
        targetCollection: 'curriculum_entries',
        targetId: 41,
      },
    ]);
  });
});

describe('course curricula links', () => {
  test('links each course to its unique current and legacy entries with the course credits and availability', async () => {
    const { checkpoint, report } = await prepare(uniqueDataset());
    const entryIds = entryIdsOf(checkpoint);

    const conversion = convertCourseCurricula({
      candidates: report.candidates.courses,
      courses: checkpoint.courses,
      entryIds,
      existing: noLinks,
    });

    const links = conversion.writes.map(({ record }) => record);
    const current = links.filter(({ generation }) => generation === '2023');
    const legacy = links.filter(({ generation }) => generation === '2018');
    const linkOf = (course: number, generation: string) =>
      links.find(
        (link) => link.course === course && link.generation === generation,
      );

    expect(links).toHaveLength(12);
    expect(current).toHaveLength(7);
    expect(legacy).toHaveLength(5);
    expect(links.filter(({ course }) => course === 1)).toEqual([
      {
        available: true,
        course: 1,
        credits: 6,
        entry: entryIds.get(entryKey('curriculum_2023', 1)),
        generation: '2023',
        sort: 1,
      },
      {
        available: false,
        course: 1,
        credits: 6,
        entry: entryIds.get(entryKey('curriculum_2018', 1)),
        generation: '2018',
        sort: 2,
      },
    ]);
    expect(linkOf(2, '2018')).toMatchObject({
      available: true,
      credits: 0,
      entry: entryIds.get(entryKey('curriculum_2018', 3)),
    });
    expect(linkOf(6, '2023')).toMatchObject({ available: false, credits: 0 });
    expect(linkOf(4, '2023')).toBeUndefined();
    expect(linkOf(4, '2018')).toBeUndefined();
    expect(linkOf(3, '2023')).toBeDefined();
    expect(linkOf(3, '2018')).toBeUndefined();
    expect(linkOf(8, '2023')).toBeDefined();
    expect(linkOf(8, '2018')).toBeUndefined();
    expect(conversion.findings).toEqual([
      expect.objectContaining({
        code: 'unlinked_generation_values',
        collection: 'courses',
        ids: [3],
        label: courseNames.gamma,
      }),
    ]);
    expect(conversion.settled).toEqual([
      expect.objectContaining({
        relation: 'curriculum_2018',
        sourceId: 3,
        status: 'unresolved',
        targetCollection: 'course_curricula',
        targetId: null,
      }),
    ]);
    expect(
      conversion.writes.flatMap(({ mappings }) => mappings),
    ).toContainEqual({
      relation: 'curriculum_2018',
      sourceCollection: 'courses',
      sourceId: 2,
      status: 'pending',
      targetCollection: 'course_curricula',
      targetId: null,
    });
  });

  test('never links an ambiguous or missing label and reports it instead', async () => {
    const { checkpoint, report } = await prepare(makeSyntheticDataset());

    const conversion = convertCourseCurricula({
      candidates: report.candidates.courses,
      courses: checkpoint.courses,
      entryIds: entryIdsOf(checkpoint),
      existing: noLinks,
    });

    expect(conversion.writes.some(({ record }) => record.course === 1)).toBe(
      false,
    );
    expect(codes(conversion.findings)).toEqual([
      'ambiguous_curriculum_2018',
      'ambiguous_curriculum_2023',
      'unlinked_generation_values',
    ]);
    expect(conversion.settled).toEqual([
      expect.objectContaining({
        relation: 'curriculum_2023',
        sourceId: 1,
        status: 'unresolved',
        targetId: null,
      }),
      expect.objectContaining({
        relation: 'curriculum_2018',
        sourceId: 1,
        status: 'unresolved',
      }),
      expect.objectContaining({
        relation: 'curriculum_2018',
        sourceId: 3,
        status: 'unresolved',
      }),
    ]);

    const base = uniqueDataset();
    const missing = await prepare({
      ...base,
      curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 1),
    });
    const unmatched = convertCourseCurricula({
      candidates: missing.report.candidates.courses,
      courses: missing.checkpoint.courses,
      entryIds: entryIdsOf(missing.checkpoint),
      existing: noLinks,
    });
    const alpha = unmatched.writes
      .map(({ record }) => record)
      .filter(({ course }) => course === 1);

    expect(codes(unmatched.findings)).toEqual([
      'unlinked_generation_values',
      'unmatched_curriculum_2023_label',
    ]);
    expect(alpha.map(({ generation }) => generation)).toEqual(['2018']);
  });
});

describe('course curricula links: rows already present', () => {
  test('reuses an existing link, retains and reports one set by hand to another entry, and fails closed when an entry was not created first', async () => {
    const { checkpoint, report } = await prepare(uniqueDataset());
    const entryIds = entryIdsOf(checkpoint);
    const alphaEntry = entryIds.get(entryKey('curriculum_2023', 1)) ?? 0;
    const existing = new Map([
      [linkKey(1, '2023'), { entry: alphaEntry, id: 77 }],
    ]);
    const manual = new Map([[linkKey(1, '2023'), { entry: 9_999, id: 77 }]]);

    const conversion = convertCourseCurricula({
      candidates: report.candidates.courses,
      courses: checkpoint.courses,
      entryIds,
      existing,
    });
    const retained = convertCourseCurricula({
      candidates: report.candidates.courses,
      courses: checkpoint.courses,
      entryIds,
      existing: manual,
    });

    expect(conversion.writes).toHaveLength(11);
    expect(conversion.settled).toContainEqual({
      relation: 'curriculum_2023',
      sourceCollection: 'courses',
      sourceId: 1,
      status: 'existing',
      targetCollection: 'course_curricula',
      targetId: 77,
    });
    expect(codes(conversion.findings)).toEqual(['unlinked_generation_values']);
    expect(retained.writes).toHaveLength(11);
    expect(retained.settled).toContainEqual(
      expect.objectContaining({
        relation: 'curriculum_2023',
        sourceId: 1,
        status: 'existing',
        targetId: 77,
      }),
    );
    expect(
      retained.findings.filter(({ code }) => code === 'manual_link_retained'),
    ).toEqual([
      expect.objectContaining({
        collection: 'course_curricula',
        ids: [77],
        label: 'Alpha Course (2023)',
      }),
    ]);
    expect(() =>
      convertCourseCurricula({
        candidates: report.candidates.courses,
        courses: checkpoint.courses,
        entryIds: none,
        existing: noLinks,
      }),
    ).toThrow('curriculum_2023');
  });
});

describe('enrollment rules', () => {
  test('seeds the fifteen academic years in chronological sort order and reuses existing ones', () => {
    const conversion = convertAcademicYears(none);

    expect(conversion.writes.map(({ record }) => record.label)).toEqual([
      ...academicYears,
    ]);
    expect(conversion.writes.map(({ record }) => record.sort)).toEqual(
      academicYears.map((_, index) => academicYears.length - index),
    );
    expect(conversion.writes[0]?.mappings).toEqual([
      {
        relation: 'label',
        sourceCollection: 'academic_years',
        sourceId: '2025/2026',
        status: 'pending',
        targetCollection: 'academic_years',
        targetId: null,
      },
    ]);

    const partial = convertAcademicYears(new Map([['2011/2012', 9]]));

    expect(partial.writes).toHaveLength(14);
    expect(partial.settled).toEqual([
      expect.objectContaining({
        sourceId: '2011/2012',
        status: 'existing',
        targetId: 9,
      }),
    ]);
  });

  test('seeds one legacy_regex rule per course and year, applying the last ascending override and recording the default literally', async () => {
    const { report } = await prepare(makeSyntheticDataset());
    const yearIds = yearIdsOf();

    const conversion = convertEnrollmentRules({
      candidates: report.candidates.courses,
      existing: noRules,
      patterns: report.candidates.patterns,
      yearIds,
    });

    const rules = conversion.writes.map(({ record }) => record);
    const ruleOf = (course: number, year: string) =>
      rules.find(
        (rule) =>
          rule.course === course && rule.academic_year === yearIds.get(year),
      );
    const alphaOverride = ruleOf(1, '2025/2026');
    const alphaDefault = ruleOf(1, '2024/2025');

    expect(rules).toHaveLength(8 * academicYears.length);
    expect(new Set(rules.map(({ mode }) => mode))).toEqual(
      new Set(['legacy_regex']),
    );
    expect(alphaOverride).toMatchObject({
      academic_year: yearIds.get('2025/2026'),
      course: 1,
      pattern: 'Alpha Honors-2025/2026',
      source_collection: 'course_enrollment_patterns',
      source_id: 2,
    });
    expect(alphaOverride?.review_note).toContain('rows 1, 2');
    expect(ruleOf(7, '2021/2022')).toMatchObject({
      pattern: thetaCrossNewlinePattern,
      source_collection: 'course_enrollment_patterns',
      source_id: 3,
    });
    expect(alphaDefault).toMatchObject({
      pattern: 'Alpha Course-2024/2025',
      source_collection: 'courses',
      source_id: 1,
    });
    expect(alphaDefault?.review_note).toContain('fallback');
    expect(ruleOf(8, '2025/2026')?.pattern).toBe('Iota 2.0 Course-2025/2026');
    expect(conversion.writes[0]?.mappings).toEqual([
      {
        relation: 'rule:2025/2026',
        sourceCollection: 'courses',
        sourceId: 1,
        status: 'pending',
        targetCollection: 'course_enrollment_rules',
        targetId: null,
      },
    ]);
    expect(codes(conversion.findings)).toEqual([
      'duplicate_pattern',
      'orphan_pattern',
    ]);
    expect(conversion.settled).toEqual([
      expect.objectContaining({
        relation: 'course',
        sourceCollection: 'course_enrollment_patterns',
        sourceId: 4,
        status: 'unresolved',
      }),
    ]);
  });

  test('freezing the seeded rules as explicit pattern rows reproduces every enrollment count of the derivation', async () => {
    const dataset = makeSyntheticDataset();
    const { report } = await prepare(dataset);
    const yearIds = yearIdsOf();
    const labels = new Map([...yearIds].map(([label, id]) => [id, label]));
    const conversion = convertEnrollmentRules({
      candidates: report.candidates.courses,
      existing: noRules,
      patterns: report.candidates.patterns,
      yearIds,
    });
    const frozen = frozenDataset(
      dataset,
      conversion.writes.map(({ record }) => record),
      labels,
    );

    await expect(deriveCourses(toCourseSources(frozen))).resolves.toEqual(
      await deriveCourses(toCourseSources(dataset)),
    );
  });

  test('reuses an existing rule row and retains and reports one whose mode or pattern was set by hand', async () => {
    const { report } = await prepare(uniqueDataset());
    const yearIds = yearIdsOf();
    const key = ruleKey(1, '2025/2026');
    const convert = (
      existing: ReadonlyMap<string, ExistingRule>,
    ): ReturnType<typeof convertEnrollmentRules> =>
      convertEnrollmentRules({
        candidates: report.candidates.courses,
        existing,
        patterns: report.candidates.patterns,
        yearIds,
      });

    const planned =
      report.candidates.courses
        .find(({ id }) => id === 1)
        ?.rules.find(({ academicYear }) => academicYear === '2025/2026')
        ?.pattern ?? '';

    const conversion = convert(
      new Map([[key, { id: 3, mode: 'legacy_regex', pattern: planned }]]),
    );
    const mapped = convert(
      new Map([[key, { id: 3, mode: 'mapped_entries', pattern: null }]]),
    );
    const edited = convert(
      new Map([
        [
          key,
          { id: 3, mode: 'legacy_regex', pattern: 'Alpha Edited-2025/2026' },
        ],
      ]),
    );

    expect(conversion.writes).toHaveLength(8 * academicYears.length - 1);
    expect(conversion.settled).toContainEqual(
      expect.objectContaining({
        relation: 'rule:2025/2026',
        sourceId: 1,
        status: 'existing',
        targetId: 3,
      }),
    );
    expect(codes(conversion.findings)).not.toContain('manual_link_retained');

    for (const retained of [mapped, edited]) {
      expect(retained.writes).toHaveLength(8 * academicYears.length - 1);
      expect(retained.settled).toContainEqual(
        expect.objectContaining({
          relation: 'rule:2025/2026',
          sourceId: 1,
          status: 'existing',
          targetId: 3,
        }),
      );
      expect(
        retained.findings.filter(({ code }) => code === 'manual_link_retained'),
      ).toEqual([
        expect.objectContaining({
          collection: 'course_enrollment_rules',
          ids: [3],
          label: courseNames.alpha,
        }),
      ]);
    }
  });
});
