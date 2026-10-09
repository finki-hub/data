import type { Candidates } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { WorkbookRows } from './workbook-rows.js';

import {
  type ChannelName,
  detailed,
  type Finding,
  finding,
} from './findings.js';
import { linkedRow, nonEmpty } from './labels.js';
import { courseLink } from './preflight-links.js';

// The Discord channel of every course a Дискорд cell names. A cell joins
// its course names with " / " exactly, so a name keeps a comma or a bare
// slash, and each name links the course of that exact name:
// - a name no course carries links nothing; the channel row is still
//   imported, and the summary places the name (unmatched_channel_course);
// - a name several courses carry blocks the import (ambiguous_course_name);
// - a course has one channel: the first channel row naming it, in the
//   order the import reads the sheet, links it, and a later name of the
//   course links nothing (duplicate_course_channel, a rule fix).

const channelNameSeparator = ' / ';

// The course names of a Дискорд cell, in cell order.
export const channelNames = (cell: null | string): readonly string[] =>
  nonEmpty(cell)?.split(channelNameSeparator) ?? [];

type Linked = { readonly channel: number; readonly column: number };

export const channelLinks = (
  rows: WorkbookRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['channels'];
  readonly findings: readonly Finding[];
} => {
  const linked = new Map<number, Linked>();
  const findings: Finding[] = [];
  for (const row of rows.discord_channels) {
    // The pair of semester N is columns 2N - 1 (alias) and 2N (names).
    const column = 2 * row.semester;
    for (const [index, name] of channelNames(row.course_names).entries()) {
      const channelName: ChannelName = { column, name: index + 1 };
      const { findings: cases, link } = courseLink(
        { collection: 'discord_channels', id: row.id, label: nonEmpty(name) },
        { indexes, orphan: 'unmatched_channel_course' },
      );
      findings.push(...cases.map((item) => detailed(item, { channelName })));
      const course = linkedRow(link);
      const used = course === null ? undefined : linked.get(course);
      if (course !== null && used === undefined) {
        linked.set(course, { channel: row.id, column });
      } else if (course !== null && used !== undefined) {
        findings.push(
          detailed(
            finding('duplicate_course_channel', 'discord_channels', [row.id]),
            {
              channelName,
              related: [{ collection: 'courses', ids: [course] }],
              usedChannel: { column: used.column, id: used.channel },
            },
          ),
        );
      }
    }
  }
  return {
    candidates: linked
      .entries()
      .map(([course, { channel }]) => ({ channel, course }))
      .toArray(),
    findings,
  };
};
