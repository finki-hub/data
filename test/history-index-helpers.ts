import type {
  HistoryIndexPort,
  HistorySummary,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/history-port.js';
import type { MembershipRow } from '../directus/extensions/directus-extension-data-operations/src/history-contract.js';

type FakeEntry = {
  first_seen: null | string;
  id: number;
  label: string;
};

type FakeMapping = {
  academic_year: number;
  course: number;
  entry: number;
};

type FakeMoodleUser = {
  coursesCount: null | number;
  id: number;
};

// The three Moodle tables the index touches, plus the raw users the
// summary compares against.
export type FakeHistory = {
  entries: FakeEntry[];
  mappings: FakeMapping[];
  memberships: MembershipRow[];
  users: FakeMoodleUser[];
};

export const freshHistory = (): FakeHistory => ({
  entries: [],
  mappings: [],
  memberships: [],
  users: [],
});

const nextId = (rows: ReadonlyArray<{ readonly id: number }>): number =>
  Math.max(0, ...rows.map(({ id }) => id)) + 1;

const membershipKey = (row: MembershipRow): string =>
  `${row.moodle_user}/${row.entry}`;

export const membershipGuardMessage =
  'Write refused: moodle_history_memberships (derived; writer: history index run)';

// What the fake port asks of its owner: the time a created entry records
// as First seen (the database's `now()`, the transaction's time), and the
// statement-level source trigger of moodle_course_entries, which fires
// once per INSERT statement, whether or not a row was inserted.
type EntryHooks = {
  readonly now: () => null | string;
  readonly onEntryStatement: () => void;
};

// An in-memory stand-in for the history SQL port of one transaction. A
// created entry records `now()` as First seen; an existing one is never
// touched. A membership write before openWriter fails like the database
// guard of the schema-constraints migration. `userIds` are the Moodle user
// ids the page planner reads.
export const fakeHistoryPort = (
  data: () => FakeHistory,
  { now, onEntryStatement }: EntryHooks,
  userIds: () => readonly number[] = () => [],
): HistoryIndexPort => {
  let writerOpen = false;
  const guard = (): void => {
    if (!writerOpen) {
      throw new Error(membershipGuardMessage);
    }
  };
  return {
    createEntries: async (labels) => {
      let created = 0;
      for (const label of labels) {
        if (data().entries.some((entry) => entry.label === label)) {
          continue;
        }
        data().entries.push({
          first_seen: now(),
          id: nextId(data().entries),
          label,
        });
        created += 1;
      }
      onEntryStatement();
      return created;
    },
    deleteMemberships: async (users) => {
      guard();
      const before = data().memberships.length;
      data().memberships = data().memberships.filter(
        (row) => !users.includes(row.moodle_user),
      );
      return before - data().memberships.length;
    },
    entriesByLabel: async (labels) =>
      data()
        .entries.filter((entry) => labels.includes(entry.label))
        .map(({ id, label }) => ({ id, label })),
    insertMemberships: async (rows) => {
      guard();
      const present = new Set(data().memberships.map(membershipKey));
      for (const row of rows) {
        if (present.has(membershipKey(row))) {
          throw new Error('duplicate key value violates unique constraint');
        }
        present.add(membershipKey(row));
        data().memberships.push({ ...row });
      }
      return rows.length;
    },
    openWriter: async () => {
      writerOpen = true;
    },
    summary: async (): Promise<HistorySummary> => {
      const { entries, memberships, users } = data();
      const indexed = new Set(memberships.map((row) => row.moodle_user));
      return {
        countMismatches: users.filter(
          ({ coursesCount, id }) =>
            (coursesCount ?? 0) !==
            memberships.filter((row) => row.moodle_user === id).length,
        ).length,
        entries: entries.length,
        indexedUsers: indexed.size,
        memberships: memberships.length,
        users: users.length,
      };
    },
    userIdsBetween: async (from, to) =>
      userIds()
        .filter((id) => id >= from && id <= to)
        .toSorted((left, right) => left - right),
  };
};
