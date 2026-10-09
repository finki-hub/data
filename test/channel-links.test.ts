import { describe, expect, test } from 'vitest';

import {
  checkSummary,
  refusalCount,
  refusalLines,
} from '../src/import-report.js';
import { channelNames } from '../src/import/channel-links.js';
import {
  finding,
  isWarning,
  placedCodes,
  ruleFixCodes,
} from '../src/import/findings.js';
import { planImport } from '../src/import/plan.js';
import { type PlannedValue, ref } from '../src/import/planned.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  courseNames,
  type SyntheticDataset,
  type SyntheticRow,
} from './fixtures/synthetic-data.js';
import { reloaded, syntheticWorkbook } from './fixtures/synthetic-workbook.js';
import { contentOf, planOf, recordsIn } from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// The Discord channel of each course, linked by the import from the course
// names of the Дискорд cells. In the parity dataset channel 1 (semester 1)
// names Gamma and Delta, channel 2 (semester 6) names Zeta; contentOf
// places channel N on Дискорд row N + 1.

const nobody = 'Synthetic Course Nobody';

const withChannels = (
  dataset: SyntheticDataset,
  channels: readonly SyntheticRow[],
): SyntheticDataset => ({ ...dataset, discord_channels: channels });

const channel = (
  id: number,
  semester: number,
  names: readonly string[],
): SyntheticRow => ({
  channel: `channel-${String(id)}`,
  course_names: names.join(' / '),
  id,
  semester,
});

// The planned channel of every course, by course name (unique in the
// parity dataset).
const channelsOf = (
  dataset: SyntheticDataset,
): ReadonlyMap<string, PlannedValue> =>
  new Map(
    recordsIn(planOf(dataset), 'courses').map((record) => {
      const name = record['name'];
      return [
        typeof name === 'string' ? name : '',
        record['discord_channel'] ?? null,
      ];
    }),
  );

const summaryOf = (dataset: SyntheticDataset) =>
  checkSummary(planOf(dataset), contentOf(dataset));

const discordCodes = new Set([
  'ambiguous_course_name',
  'duplicate_course_channel',
  'unmatched_channel_course',
]);

describe('the course names of a Дискорд cell', () => {
  test('split on " / " exactly, so a name with a comma or a bare slash stays whole', () => {
    expect(channelNames('Gamma Course / Delta Course')).toEqual([
      'Gamma Course',
      'Delta Course',
    ]);
    expect(channelNames('Компјутерски звук, музика и говор')).toEqual([
      'Компјутерски звук, музика и говор',
    ]);
    expect(channelNames('Gamma/Delta')).toEqual(['Gamma/Delta']);
    expect(channelNames('Gamma Course /  / Delta Course')).toEqual([
      'Gamma Course',
      '',
      'Delta Course',
    ]);
    expect(channelNames(null)).toEqual([]);
    expect(channelNames('')).toEqual([]);
  });
});

describe('the Discord channel of a course', () => {
  test('links every course a cell names to that channel row, and no other course', () => {
    const dataset = parityDataset();
    const plan = planOf(dataset);
    const linked = channelsOf(dataset);

    expect(refusalCount(plan)).toBe(0);
    expect(linked.get(courseNames.gamma)).toEqual(ref('discord_channels', 1));
    expect(linked.get(courseNames.delta)).toEqual(ref('discord_channels', 1));
    expect(linked.get(courseNames.zeta)).toEqual(ref('discord_channels', 2));
    expect(
      linked
        .values()
        .filter((value) => value !== null)
        .toArray(),
    ).toHaveLength(3);
    expect(
      [...plan.blockers, ...plan.warnings].filter(({ code }) =>
        discordCodes.has(code),
      ),
    ).toEqual([]);
    // The channel rows keep their semester and alias; the names are links.
    expect(recordsIn(plan, 'discord_channels')).toEqual([
      { semester: 1, channel: 'gamma-and-delta' },
      { semester: 6, channel: 'zeta' },
    ]);
  });

  test('links nothing for a name no course carries, imports the channel row, and places the name', () => {
    const dataset = withChannels(parityDataset(), [
      channel(1, 1, [courseNames.gamma, nobody, courseNames.delta]),
      channel(2, 6, [courseNames.zeta]),
    ]);
    const plan = planOf(dataset);
    const summary = summaryOf(dataset);

    expect(refusalCount(plan)).toBe(0);
    expect(summary.warnings).toMatchObject({ unmatched_channel_course: 1 });
    expect(summary.fixes).toMatchObject({
      unmatched_channel_course: ['Дискорд row 2, column 2, name 2'],
    });
    expect(channelsOf(dataset).get(courseNames.delta)).toEqual(
      ref('discord_channels', 1),
    );
    expect(recordsIn(plan, 'discord_channels')).toHaveLength(2);
    expect(JSON.stringify(summary)).not.toContain(nobody);
  });

  test('places an empty name of a cell as a name no course carries', () => {
    const dataset = withChannels(parityDataset(), [
      {
        ...channel(1, 1, []),
        course_names: `${courseNames.gamma} /  / ${courseNames.delta}`,
      },
    ]);

    expect(summaryOf(dataset).fixes).toMatchObject({
      unmatched_channel_course: ['Дискорд row 2, column 2, name 2'],
    });
  });

  test('blocks on a name several courses carry, placing the name by its cell and naming the course rows', () => {
    const base = parityDataset();
    const [first] = base.courses;
    const dataset: SyntheticDataset = {
      ...base,
      courses: [...base.courses, { ...first, id: 90, name: courseNames.zeta }],
    };
    const plan = planOf(dataset);
    const zetaRows = dataset.courses
      .flatMap((row, index) =>
        row['name'] === courseNames.zeta ? [index + 2] : [],
      )
      .join(', ');

    expect(refusalLines(plan, contentOf(dataset))).toContain(
      `- [ambiguous_course_name] Дискорд row 3, column 12, name 1 «Zeta Course»: matches Предмети (Export) rows ${zetaRows}`,
    );
    expect(channelsOf(dataset).get(courseNames.zeta)).toBeNull();
  });

  test('keeps the first channel row naming a course, ignores a later name of it, and places that name with the row used', () => {
    const dataset = withChannels(parityDataset(), [
      channel(1, 1, [courseNames.gamma, courseNames.delta]),
      channel(2, 6, [courseNames.zeta, courseNames.gamma]),
      channel(3, 1, [courseNames.delta]),
      channel(4, 2, [courseNames.beta, courseNames.beta]),
    ]);
    const plan = planOf(dataset);
    const linked = channelsOf(dataset);

    expect(refusalCount(plan)).toBe(0);
    expect(linked.get(courseNames.gamma)).toEqual(ref('discord_channels', 1));
    expect(linked.get(courseNames.delta)).toEqual(ref('discord_channels', 1));
    expect(linked.get(courseNames.zeta)).toEqual(ref('discord_channels', 2));
    expect(linked.get(courseNames.beta)).toEqual(ref('discord_channels', 4));
    expect(summaryOf(dataset)).toMatchObject({
      fixes: {
        duplicate_course_channel: [
          // Another semester's row: its column too.
          'Дискорд row 3, column 12, name 2 (used: row 2, column 2)',
          // The same column.
          'Дискорд row 4, column 2, name 1 (used: row 2)',
          // A name listed again in one cell.
          'Дискорд row 5, column 4, name 2 (used: row 5)',
        ],
      },
      warnings: { duplicate_course_channel: 3 },
    });
  });

  test('reads the column of each cell from its semester, and keeps the first row in the order the sheet is read', async () => {
    // Channel 1 (semester 6) is read after channel 2 (semester 1), each on
    // row 2 of its column pair.
    const dataset = withChannels(parityDataset(), [
      channel(1, 6, [courseNames.zeta, nobody]),
      channel(2, 1, [courseNames.gamma, courseNames.zeta]),
    ]);
    const content = readWorkbookContent(
      await reloaded(syntheticWorkbook(dataset)),
    );
    const plan = planImport(content);
    const courses = recordsIn(plan, 'courses');

    expect(checkSummary(plan, content).fixes).toMatchObject({
      duplicate_course_channel: [
        'Дискорд row 2, column 12, name 1 (used: row 2, column 2)',
      ],
      unmatched_channel_course: ['Дискорд row 2, column 12, name 2'],
    });
    // Ordinal 1 is the semester-1 row, read first.
    expect(recordsIn(plan, 'discord_channels')).toEqual([
      { semester: 1, channel: 'channel-2' },
      { semester: 6, channel: 'channel-1' },
    ]);
    expect(
      courses.find((record) => record['name'] === courseNames.zeta),
    ).toMatchObject({ discord_channel: ref('discord_channels', 1) });
  });
});

describe('the Discord codes', () => {
  test('are warnings; a later name of a course is a rule fix, and a name no course carries is placed without being one', () => {
    for (const code of [
      'duplicate_course_channel',
      'unmatched_channel_course',
    ] as const) {
      expect(isWarning(finding(code, 'discord_channels', [1]))).toBeTruthy();
    }

    expect([...ruleFixCodes]).toContain('duplicate_course_channel');
    expect([...ruleFixCodes]).not.toContain('unmatched_channel_course');
    expect([...placedCodes]).toEqual([
      ...ruleFixCodes,
      'unmatched_channel_course',
    ]);
  });
});
