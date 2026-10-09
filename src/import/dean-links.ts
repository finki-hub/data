import type { Candidates } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { WorkbookRows } from './workbook-rows.js';

import { detailed, type Finding, finding } from './findings.js';
import { linkedRow, nonEmpty, resolveLabel } from './labels.js';

// The staff member of every Деканат row: its Име names the staff row of
// exactly that name (no trimming), as a teaching line does. A term needs
// its staff member, so a row naming none (unmatched_staff_name), several
// (ambiguous_staff_name) or no one at all (invalid_source_row) blocks the
// import and is not planned.

const collection = 'deans_office';

export const deanLinks = (
  rows: WorkbookRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['deans'];
  readonly findings: readonly Finding[];
} => {
  const candidates: Array<Candidates['deans'][number]> = [];
  const findings: Finding[] = [];
  for (const { id, name } of rows.deans_office) {
    const link = resolveLabel(nonEmpty(name), indexes.staff);
    const staff = linkedRow(link);
    if (staff !== null) {
      candidates.push({ id, staff });
    } else if (link.resolution === 'ambiguous') {
      findings.push(
        detailed(finding('ambiguous_staff_name', collection, [id]), {
          related: [{ collection: 'staff', ids: link.matches }],
        }),
      );
    } else {
      findings.push(
        finding(
          link.resolution === 'missing'
            ? 'unmatched_staff_name'
            : 'invalid_source_row',
          collection,
          [id],
        ),
      );
    }
  }
  return { candidates, findings };
};
