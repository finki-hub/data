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
import { isRef } from '../src/import/planned.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  courseNames,
  type SyntheticDataset,
  type SyntheticRow,
} from './fixtures/synthetic-data.js';
import { reloaded, syntheticWorkbook } from './fixtures/synthetic-workbook.js';
import { contentOf, planOf, recordsIn } from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// The Discord channels of each course, linked by the import from the
// course names of the Предмет cells of the Discord sheet. In the parity
// dataset channel 1 (semester 1) names Gamma and Delta, channel 2
// (semester 6) names Zeta; the sheet heads its table on row 4, so
// contentOf places channel N on Discord row N + 4.

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

// The planned channel rows (plan keys) of every course, by course name
// (unique in the parity dataset), from the junction rows.
const channelsOf = (
  plan: ReturnType<typeof planOf>,
): ReadonlyMap<string, readonly string[]> => {
  const names = recordsIn(plan, 'courses').map((record) =>
    typeof record['name'] === 'string' ? record['name'] : '',
  );
  const linked = new Map<string, string[]>();
  for (const record of recordsIn(plan, 'discord_channel_courses')) {
    const { course, discord_channel: channelRef } = record;
    if (
      course === undefined ||
      channelRef === undefined ||
      !isRef(course) ||
      !isRef(channelRef)
    ) {
      throw new TypeError('a junction row links by reference');
    }
    const name = names[Number(course.key) - 1] ?? '';
    linked.set(name, [...(linked.get(name) ?? []), channelRef.key]);
  }
  return linked;
};

const summaryOf = (dataset: SyntheticDataset) =>
  checkSummary(planOf(dataset), contentOf(dataset));

const discordCodes = new Set([
  'ambiguous_course_name',
  'unmatched_channel_course',
]);

describe('the course names of a Предмет cell', () => {
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

describe('the Discord channels of a course', () => {
  test('links every course a cell names to that channel row, and no other course', () => {
    const dataset = parityDataset();
    const plan = planOf(dataset);
    const linked = channelsOf(plan);

    expect(refusalCount(plan)).toBe(0);
    expect(linked.get(courseNames.gamma)).toEqual(['1']);
    expect(linked.get(courseNames.delta)).toEqual(['1']);
    expect(linked.get(courseNames.zeta)).toEqual(['2']);
    expect(linked.size).toBe(3);
    expect(
      [...plan.blockers, ...plan.warnings].filter(({ code }) =>
        discordCodes.has(code),
      ),
    ).toEqual([]);
    // The channel rows keep their semester and alias; the names are links,
    // and a course row carries none.
    expect(recordsIn(plan, 'discord_channels')).toEqual([
      { semester: 1, channel: 'gamma-and-delta' },
      { semester: 6, channel: 'zeta' },
    ]);

    for (const record of recordsIn(plan, 'courses')) {
      expect(record).not.toHaveProperty('discord_channel');
    }
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
      unmatched_channel_course: ['Discord row 5, column "Предмет", name 2'],
    });
    expect(channelsOf(plan).get(courseNames.delta)).toEqual(['1']);
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
      unmatched_channel_course: ['Discord row 5, column "Предмет", name 2'],
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
      `- [ambiguous_course_name] Discord row 6, column "Предмет", name 1 «Zeta Course»: matches Предмети (Export) rows ${zetaRows}`,
    );
    expect(channelsOf(plan).get(courseNames.zeta)).toBeUndefined();
  });

  test('links a course to every channel naming it, and a name repeated in one cell once, with no finding', () => {
    const dataset = withChannels(parityDataset(), [
      channel(1, 1, [courseNames.gamma, courseNames.delta]),
      channel(2, 9, [courseNames.zeta, courseNames.gamma]),
      channel(3, 1, [courseNames.delta]),
      channel(4, 2, [courseNames.beta, courseNames.beta]),
    ]);
    const plan = planOf(dataset);
    const linked = channelsOf(plan);

    expect(refusalCount(plan)).toBe(0);
    expect(linked.get(courseNames.gamma)).toEqual(['1', '2']);
    expect(linked.get(courseNames.delta)).toEqual(['1', '3']);
    expect(linked.get(courseNames.zeta)).toEqual(['2']);
    expect(linked.get(courseNames.beta)).toEqual(['4']);
    expect(recordsIn(plan, 'discord_channel_courses')).toHaveLength(6);
    expect(
      [...plan.blockers, ...plan.warnings].filter(({ code }) =>
        discordCodes.has(code),
      ),
    ).toEqual([]);
  });

  test('reads the table below its header row, past a blank row, in sheet order', async () => {
    const dataset = withChannels(parityDataset(), [
      channel(1, 6, [courseNames.zeta, nobody]),
      channel(2, 1, [courseNames.gamma, courseNames.zeta]),
    ]);
    const content = readWorkbookContent(
      await reloaded(syntheticWorkbook(dataset)),
    );
    const plan = planImport(content);

    expect(checkSummary(plan, content).fixes).toMatchObject({
      unmatched_channel_course: ['Discord row 5, column "Предмет", name 2'],
    });
    // Ordinals follow the rows of the sheet, whatever their semester.
    expect(recordsIn(plan, 'discord_channels')).toEqual([
      { semester: 6, channel: 'channel-1' },
      { semester: 1, channel: 'channel-2' },
    ]);
    expect(channelsOf(plan).get(courseNames.zeta)).toEqual(['1', '2']);
  });
});

describe('the Discord codes', () => {
  test('are warnings; a name no course carries is placed without being a rule fix', () => {
    expect(
      isWarning(finding('unmatched_channel_course', 'discord_channels', [1])),
    ).toBeTruthy();
    expect([...ruleFixCodes]).not.toContain('unmatched_channel_course');
    expect([...placedCodes]).toEqual([
      ...ruleFixCodes,
      'unmatched_channel_course',
    ]);
  });
});
