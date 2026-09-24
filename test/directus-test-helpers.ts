import { vi } from 'vitest';
import { z } from 'zod';

import type { DirectusConfig } from '../src/config.js';
import type { MigrationData } from '../src/schema.js';
import type { WorkbookContent } from '../src/workbook.js';

import {
  specProgramHeaders,
  workbookPrograms,
} from '../src/migrations/generations.js';
import { academicYears } from '../src/specs/public.js';

export type RequestRecord = {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
};

export const config: DirectusConfig = {
  token: 'test-token',
  url: new URL('https://directus.test'),
};

export const emptyData: MigrationData = {
  course_enrollment_patterns: [],
  course_equivalencies: [],
  courses: [],
  curriculum_2018: [],
  curriculum_2023: [],
  deans_office: [],
  discord_channels: [],
  moodle_users: [],
  rooms: [],
  staff: [],
  student_council: [],
  students: [],
  teaching_assignments: [],
};

// An empty workbook: no rows, the checkpoint's academic years and the
// study programs of the checkpoint's curriculum sheets.
export const emptyWorkbook: WorkbookContent = {
  academicYears,
  data: emptyData,
  studyPrograms: workbookPrograms(specProgramHeaders),
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
