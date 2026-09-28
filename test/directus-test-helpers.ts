import { vi } from 'vitest';
import { z } from 'zod';

import type { DirectusConfig } from '../src/config.js';
import type { WorkbookContent } from '../src/workbook.js';

import { type MigrationData, perWorkbookKey } from '../src/schema.js';
import { academicYears } from './fixtures/synthetic-data.js';
import { syntheticPrograms } from './fixtures/synthetic-workbook.js';

export type RequestRecord = {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
};

export const config: DirectusConfig = {
  token: 'test-token',
  url: new URL('https://directus.test'),
};

export const emptyData: MigrationData = perWorkbookKey(() => []);

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

export const recordRequests = (): RequestRecord[] => {
  const requests: RequestRecord[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        body:
          typeof init?.body === 'string'
            ? z.json().parse(JSON.parse(init.body))
            : null,
        method: init?.method ?? 'GET',
        pathname: toUrl(input).pathname,
      });

      return Response.json({ data: [] });
    }),
  );

  return requests;
};

export const findNamedRequest = (
  requests: readonly RequestRecord[],
  pathname: string,
  name: string,
): RequestRecord | undefined =>
  requests.find(
    ({ body, pathname: requestPath }) =>
      requestPath === pathname &&
      typeof body === 'object' &&
      body !== null &&
      'name' in body &&
      body.name === name,
  );
