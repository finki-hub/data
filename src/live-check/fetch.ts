import { z } from 'zod';

import { unanswered } from '../directus-request.js';
import { errorText } from '../text.js';

// The public files the live check compares, as consumers read them from
// the live bucket. students.json is never fetched.
export const liveFiles = ['courses.json', 'staff.json', 'rooms.json'] as const;

export type LiveFile = (typeof liveFiles)[number];

export type PublicRow = Readonly<Record<string, string>>;

export type LiveData = Readonly<Record<LiveFile, readonly PublicRow[]>>;

// The fetch the live check uses; tests inject one.
export type Fetch = (
  url: URL,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

const liveOrigin = 'https://assets.finki-hub.com/';

// How long the request of one file may take, its body included.
const fetchTimeoutMs = 30_000;

// A public file as consumers read it: rows of text values.
export const publicRows = z.array(z.record(z.string(), z.string()));

const bodyOf = async (file: LiveFile, response: Response) => {
  try {
    const body: unknown = await response.json();
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${file}: invalid JSON`, { cause: error });
    }
    throw unanswered(file, error, fetchTimeoutMs);
  }
};

// One live file: an array of rows of text values, or a failure placed at
// the file: `courses.json: HTTP 503`, `staff.json: unexpected response:
// <path>: <message>`.
const fetchFile = async (
  fetcher: Fetch,
  file: LiveFile,
): Promise<readonly PublicRow[]> => {
  let response: Response;
  try {
    response = await fetcher(new URL(file, liveOrigin), {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch (error) {
    throw unanswered(file, error, fetchTimeoutMs);
  }
  if (!response.ok) {
    throw new Error(`${file}: HTTP ${String(response.status)}`);
  }
  const parsed = publicRows.safeParse(await bodyOf(file, response));
  if (!parsed.success) {
    throw new Error(`${file}: ${errorText(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
};

// The live files, read into memory one after the other; nothing is
// written to disk.
export const fetchLiveFiles = async (fetcher: Fetch): Promise<LiveData> => {
  const courses = await fetchFile(fetcher, 'courses.json');
  const staff = await fetchFile(fetcher, 'staff.json');
  const rooms = await fetchFile(fetcher, 'rooms.json');
  return { 'courses.json': courses, 'rooms.json': rooms, 'staff.json': staff };
};
