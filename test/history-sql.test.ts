import { describe, expect, test } from 'vitest';

import type { HistoryIndexPort } from '../directus/extensions/directus-extension-data-operations/src/coordination/history-port.js';

import { historySqlPort } from '../directus/extensions/directus-extension-data-operations/src/coordination/history-sql.js';

// The statements of the history index port as the database receives them.
// The fake port of the index tests mirrors them; these pin the SQL: an
// entry gets its First seen in the INSERT that creates it, and nothing
// ever writes an existing entry.

type Sent = { readonly bindings: readonly unknown[]; readonly sql: string };

const summaryRow = {
  count_mismatches: 1,
  entries: 4,
  indexed_users: 2,
  memberships: 5,
  users: 3,
};

const entryWritePattern =
  /\b(?:DELETE FROM|INSERT INTO|UPDATE)\s+"moodle_course_entries"/u;
const reviewPattern = /needs_mapping|review_state/u;

// Every statement the port sent. The summary is answered with one row,
// every other statement with no row and a row count of 2.
const recording = () => {
  const sent: Sent[] = [];
  const port = historySqlPort({
    raw: async (sql, bindings = []) => {
      sent.push({ bindings, sql });
      return {
        rowCount: 2,
        rows: sql.includes('AS "count_mismatches"') ? [summaryRow] : [],
      };
    },
  });
  return { port, sent };
};

// One call of every port method, the entry INSERT first.
const everyCall = async (port: HistoryIndexPort): Promise<void> => {
  await port.createEntries(['Alpha', 'Beta']);
  await port.deleteMemberships([1]);
  await port.entriesByLabel(['Alpha']);
  await port.insertMemberships([{ entry: 1, moodle_user: 1, sort: 0 }]);
  await port.openWriter();
  await port.summary();
  await port.userIdsBetween(1, 2);
};

describe('history index statements', () => {
  test('create entries in one INSERT that records now() as First seen and skips an existing label', async () => {
    const { port, sent } = recording();

    await expect(port.createEntries(['Alpha', 'Beta'])).resolves.toBe(2);
    expect(sent).toEqual([
      {
        bindings: [JSON.stringify(['Alpha', 'Beta'])],
        sql: `INSERT INTO "moodle_course_entries" ("label", "first_seen")
SELECT wanted."value", now() FROM json_array_elements_text(?::json) AS wanted
ON CONFLICT ("label") DO NOTHING`,
      },
    ]);
  });

  test('write an entry only in that INSERT, and First seen nowhere else', async () => {
    const { port, sent } = recording();

    await everyCall(port);

    const statements = sent.map(({ sql }) => sql);
    const [insert] = statements;

    expect(statements).toHaveLength(7);
    expect(statements.filter((sql) => entryWritePattern.test(sql))).toEqual([
      insert,
    ]);
    expect(statements.filter((sql) => sql.includes('first_seen'))).toEqual([
      insert,
    ]);
  });

  test('summarise users, index and entries without a review state', async () => {
    const { port, sent } = recording();

    await expect(port.summary()).resolves.toEqual({
      countMismatches: 1,
      entries: 4,
      indexedUsers: 2,
      memberships: 5,
      users: 3,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sql).not.toMatch(reviewPattern);
  });
});
