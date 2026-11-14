import type { Candidates } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { WorkbookRows } from './workbook-rows.js';

import { type ChannelName, detailed, type Finding } from './findings.js';
import { linkedRow, nonEmpty } from './labels.js';
import { courseLink } from './preflight-links.js';

// The courses of every Discord channel row. Its Предмет cell joins the
// course names with " / " exactly, so a name keeps a comma or a bare
// slash, and each name links the course of that exact name:
// - a name no course carries links nothing; the channel row is still
//   imported, and the summary places the name (unmatched_channel_course);
// - a name several courses carry blocks the import (ambiguous_course_name);
// - a course may have several channels (an undergraduate and a master's
//   one), so every channel naming it links it; a name repeated in one
//   cell links the course once.

const channelNameSeparator = ' / ';

// The course names of a Предмет cell, in cell order.
export const channelNames = (cell: null | string): readonly string[] =>
  nonEmpty(cell)?.split(channelNameSeparator) ?? [];

export const channelLinks = (
  rows: WorkbookRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['channels'];
  readonly findings: readonly Finding[];
} => {
  const candidates: Array<Candidates['channels'][number]> = [];
  const findings: Finding[] = [];
  for (const row of rows.discord_channels) {
    const linked = new Set<number>();
    for (const [index, name] of channelNames(row.course_names).entries()) {
      const channelName: ChannelName = { name: index + 1 };
      const { findings: cases, link } = courseLink(
        { collection: 'discord_channels', id: row.id, label: nonEmpty(name) },
        { indexes, orphan: 'unmatched_channel_course' },
      );
      findings.push(...cases.map((item) => detailed(item, { channelName })));
      const course = linkedRow(link);
      if (course !== null && !linked.has(course)) {
        linked.add(course);
        candidates.push({ channel: row.id, course });
      }
    }
  }
  return { candidates, findings };
};
