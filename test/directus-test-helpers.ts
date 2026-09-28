import type { DirectusConfig } from '../src/config.js';
import type { WorkbookContent } from '../src/workbook.js';

import { perWorkbookKey, type WorkbookData } from '../src/schema.js';
import { academicYears } from './fixtures/synthetic-data.js';
import { syntheticPrograms } from './fixtures/synthetic-workbook.js';

export const config: DirectusConfig = {
  token: 'test-token',
  url: new URL('https://directus.test'),
};

export const emptyData: WorkbookData = perWorkbookKey(() => []);

// An empty workbook: no rows, the synthetic academic years and the study
// programs of the synthetic curriculum sheets.
export const emptyWorkbook: WorkbookContent = {
  academicYears,
  data: emptyData,
  places: perWorkbookKey(() => []),
  studyPrograms: syntheticPrograms,
};

export const toUrl = (input: Parameters<typeof fetch>[0]): URL => {
  if (typeof input === 'string') {
    return new URL(input);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(input.url);
};
