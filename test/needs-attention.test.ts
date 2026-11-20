import { describe, expect, test } from 'vitest';

import type { SqlClient } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import type { StatusView } from '../directus/extensions/directus-extension-data-operations/src/status-contract.js';

import {
  attentionListLimit,
  lookalikesFromYear,
  readAttention,
  staleAfterHours,
} from '../directus/extensions/directus-extension-data-operations/src/attention-reads.js';
import {
  attentionTotal,
  importStoppedText,
  moreText,
} from '../directus/extensions/directus-extension-data-operations/src/status-facts.js';

// A database stand-in that answers each statement by what it reads.
const fakeSql = (answers: {
  readonly faculty?: readonly unknown[];
  readonly lookalikes: readonly unknown[];
  readonly stale: readonly unknown[];
  readonly unmatched: readonly unknown[];
}) => {
  const calls: Array<{ bindings: unknown; sql: string }> = [];
  const sql = {
    raw: (statement: string, bindings?: unknown) => {
      calls.push({ bindings, sql: statement });
      if (statement.includes('moodle_left_uncounted')) {
        return Promise.resolve({ rows: answers.lookalikes });
      }
      if (statement.includes('faculty_import_issues')) {
        return Promise.resolve({ rows: answers.faculty ?? [] });
      }
      if (statement.includes('room_match')) {
        return Promise.resolve({ rows: answers.unmatched });
      }
      return Promise.resolve({ rows: answers.stale });
    },
  } as unknown as SqlClient;
  return { calls, sql };
};

describe('Needs attention', () => {
  test('reads the look-alike Moodle courses, unmatched names and stopped imports', async () => {
    const { calls, sql } = fakeSql({
      faculty: [
        {
          body: 'Teaching and research council',
          detail: null,
          id: 7,
          kind: 'unmatched_person',
          name: 'д-р Ново Лице',
          total: '2',
        },
      ],
      lookalikes: [
        {
          course: 'Применета криптографија',
          id: 9,
          label: 'Applied Cryptography II - 2025/2026/Z',
          total: '3',
        },
      ],
      stale: [
        {
          flow: 'Data / Import timetables',
          last_at: null,
          name: 'Timetables',
          stale: true,
        },
        {
          flow: 'Data / Import theses',
          last_at: '2026-11-19T05:00:00.000Z',
          name: 'Theses',
          stale: false,
        },
      ],
      unmatched: [
        {
          collection: 'timetable_slots',
          id: 4,
          kind: 'room',
          name: 'Б 3.2',
          total: 1,
        },
      ],
    });

    await expect(readAttention(sql)).resolves.toEqual({
      faculty: {
        count: 2,
        items: [
          {
            body: 'Teaching and research council',
            detail: null,
            kind: 'unmatched_person',
            link: '/content/faculty_import_issues/7',
            name: 'д-р Ново Лице',
          },
        ],
      },
      lookalikes: {
        count: 3,
        items: [
          {
            course: 'Применета криптографија',
            label: 'Applied Cryptography II - 2025/2026/Z',
            link: '/content/moodle_course_entries/9',
          },
        ],
      },
      stale: [
        { flow: 'Data / Import timetables', lastAt: null, name: 'Timetables' },
      ],
      unmatched: {
        count: 1,
        items: [
          { kind: 'room', link: '/content/timetable_slots/4', name: 'Б 3.2' },
        ],
      },
    });
    expect(calls.map(({ bindings }) => bindings)).toEqual([
      [lookalikesFromYear, attentionListLimit],
      [attentionListLimit],
      [attentionListLimit],
      [staleAfterHours, staleAfterHours, staleAfterHours],
    ]);
    // A course left uncounted on purpose, and an uncounted line of an
    // older curriculum or of few students, stay off the list.
    expect(calls[0]?.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM moodle_left_uncounted u WHERE u.entry = e.id)',
    );
    expect(calls[0]?.sql).toContain("substring(e.label from '(20[0-9]{2})')");
    expect(calls[0]?.sql).toContain('HAVING COUNT(*) >= 5');
    // Only the recent timetables, which courses.json reads.
    expect(calls[1]?.sql.match(/t\.recent/gu)).toHaveLength(3);
  });

  test('counts nothing when every list is empty', async () => {
    const { sql } = fakeSql({ lookalikes: [], stale: [], unmatched: [] });

    await expect(readAttention(sql)).resolves.toEqual({
      faculty: { count: 0, items: [] },
      lookalikes: { count: 0, items: [] },
      stale: [],
      unmatched: { count: 0, items: [] },
    });
  });

  test('totals every problem, failed calculations included', () => {
    const status = {
      attention: {
        faculty: { count: 4, items: [] },
        lookalikes: { count: 2, items: [] },
        stale: [{ flow: 'Data / Import theses', lastAt: null, name: 'Theses' }],
        unmatched: { count: 3, items: [] },
      },
      domains: [
        {
          kind: 'calculation',
          label: 'Enrollments',
          name: 'enrollments',
          state: 'failed',
          waitingFor: [],
        },
        {
          kind: 'calculation',
          label: 'History',
          name: 'history_index',
          state: 'current',
          waitingFor: [],
        },
      ],
    } as unknown as StatusView;

    expect(attentionTotal(status)).toBe(11);
  });

  test('says how many rows a list leaves out and when an import last succeeded', () => {
    expect(moreText({ count: 30, items: [1, 2] })).toBe('And 28 more.');
    expect(moreText({ count: 2, items: [1, 2] })).toBeNull();
    expect(
      importStoppedText({
        flow: 'Data / Import theses',
        lastAt: '2026-11-17T05:00:00.813Z',
        name: 'Theses',
      }),
    ).toBe(
      'Theses: last success 2026-11-17 05:00:00 UTC. Run Data / Import theses to see why.',
    );
    expect(
      importStoppedText({
        flow: 'Data / Import timetables',
        lastAt: null,
        name: 'Timetables',
      }),
    ).toBe(
      'Timetables: last success never. Run Data / Import timetables to see why.',
    );
  });
});
