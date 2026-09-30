import { describe, expect, test } from 'vitest';

import { fileTooLarge } from '../directus/extensions/directus-extension-data-operations/src/snapshot/decisions.js';
import {
  claimBusy,
  claimLost,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/errors.js';
import { describeWarnings } from '../directus/extensions/directus-extension-data-operations/src/snapshot/rows.js';

// The snapshot refusals and warnings several sites share, each worded
// once.
describe('snapshot texts', () => {
  test('word one file size limit for the declared size and the streaming check', () => {
    expect(fileTooLarge(1_000_000, 2_000_000)).toMatchObject({
      code: 'SNAPSHOT_FILE_INVALID',
      message:
        'File size 2000000 bytes, max 1000000 (FINKI_HUB_SNAPSHOT_MAX_BYTES)',
      status: 400,
    });
    expect(fileTooLarge(268_435_456).message).toBe(
      'File size above max 268435456 bytes (FINKI_HUB_SNAPSHOT_MAX_BYTES)',
    );
  });

  test('word a lost and a busy claim once, by stage and by the domain holding it', () => {
    expect(claimLost('promotion')).toMatchObject({
      code: 'SNAPSHOT_CLAIM_LOST',
      message: 'Snapshot claim lost during promotion',
      status: 409,
    });
    expect(claimLost('backup').message).toBe(
      'Snapshot claim lost during backup',
    );
    expect(claimBusy('enrollments')).toMatchObject({
      code: 'SNAPSHOT_CLAIM_BUSY',
      message: 'Claim busy: enrollments',
      status: 409,
    });
    expect(claimBusy().message).toBe('Claim busy');
  });

  test('name the flagged rows of a warning, at most five of them', () => {
    expect(
      describeWarnings({
        historyLinesOverLimit: { count: 2, rows: [3, 7] },
      }),
    ).toBe('HISTORY_LINE_TOO_LONG: 2 rows over 2048 bytes: 3, 7');
    expect(
      describeWarnings({
        historyLinesOverLimit: { count: 23, rows: [1, 2, 3, 4, 5, 6] },
      }),
    ).toBe(
      'HISTORY_LINE_TOO_LONG: 23 rows over 2048 bytes: 1, 2, 3, 4, 5 (+18 more)',
    );
  });
});
