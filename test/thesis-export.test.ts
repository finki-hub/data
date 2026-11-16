import { describe, expect, test } from 'vitest';

import type { SourceRead } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import {
  bachelorTheses,
  masterTheses,
} from '../directus/extensions/directus-extension-data-operations/src/exports/theses.js';
import { insertCommitteeSql } from '../directus/extensions/directus-extension-data-operations/src/theses/sql.js';
import { bachelorTable } from '../directus/extensions/directus-extension-data-operations/src/theses/vocabulary.js';
import { engineAssets } from './relational-export-helpers.js';

// The rows each collection answers, whatever the read asks.
const readerOf =
  (rows: Readonly<Record<string, readonly unknown[]>>) =>
  (read: SourceRead): Promise<readonly unknown[]> =>
    Promise.resolve(rows[read.collection] ?? []);

describe('the thesis files', () => {
  test('publish each thesis with its matched staff by their staff name, the rest as written', async () => {
    const files = await engineAssets(
      [bachelorTheses, masterTheses],
      readerOf({
        bachelor_thesis_staff: [
          {
            id: 1,
            name: 'Магдалена Костоска',
            staff: { name: 'Магдалена Костоска Ѓорчевска' },
            thesis: 2,
          },
          {
            id: 2,
            name: 'Иван Чорбев',
            staff: { name: 'Иван Чорбев' },
            thesis: 2,
          },
        ],
        bachelor_theses: [
          {
            description: null,
            file_id: '9850',
            id: 2,
            member_1: 'Магдалена Костоска',
            member_2: 'Горан Петковски',
            mentor: 'Иван Чорбев',
            status: 'Одбрана',
            student_index: '216022',
            student_name: 'Бојана Јанческа',
            submitted: '2025-12-20',
            title: 'Наслов',
          },
          { id: 1, title: 'Прва' },
        ],
        master_theses: [
          {
            id: 7,
            member: 'Hasan Dağ',
            mentor: 'Ристе Стојанов',
            presented: null,
            president: 'Костадин Мишев',
            title: 'Title',
          },
        ],
        master_thesis_staff: [
          {
            id: 3,
            name: 'Hasan Dağ',
            staff: { name: 'Хасан Даг' },
            thesis: 7,
          },
        ],
      }),
    );

    expect(files).toEqual({
      bachelor_theses: [
        { title: 'Прва' },
        {
          file_id: '9850',
          member_1: 'Магдалена Костоска Ѓорчевска',
          member_2: 'Горан Петковски',
          mentor: 'Иван Чорбев',
          status: 'Одбрана',
          student_index: '216022',
          student_name: 'Бојана Јанческа',
          submitted: '2025-12-20',
          title: 'Наслов',
        },
      ],
      master_theses: [
        {
          member: 'Хасан Даг',
          mentor: 'Ристе Стојанов',
          president: 'Костадин Мишев',
          title: 'Title',
        },
      ],
    });
  });

  test('keep the name each staff link was matched from', () => {
    expect(insertCommitteeSql(bachelorTable)).toContain(
      'SELECT DISTINCT ON (n."thesis", s."staff", n."role") n."thesis", s."staff", n."role", n."name"',
    );
  });
});
