import type { WorkbookRows } from './workbook-rows.js';

import { codeLevel } from '../../directus/extensions/directus-extension-data-operations/src/exports/curriculum-code.js';
import { type Finding, finding } from './findings.js';

// Every curriculum row, linked or not, whose code is not empty and gives
// no level (codeLevel): one blocker per row. No rule can fix a code, and
// the database refuses such a code (curriculum_entries_code_guard); an
// empty code publishes no code and no level.
export const codeFindings = (rows: WorkbookRows): readonly Finding[] =>
  (['curriculum_2023', 'curriculum_2018'] as const).flatMap((sheet) =>
    rows[sheet].flatMap(({ code, id }) =>
      code === null || code === '' || codeLevel(code) !== null
        ? []
        : [finding('curriculum_code_without_level', sheet, [id])],
    ),
  );
