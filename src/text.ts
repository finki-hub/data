import { z } from 'zod';

import {
  issuesText,
  countText as sharedCountText,
  listText as sharedListText,
  pluralText as sharedPluralText,
} from '../directus/extensions/directus-extension-data-operations/src/text.js';

// The text forms of the lifecycle commands. Counts, lists and issues are
// the data-operations extension's forms, so the commands and the extension
// write them alike.

// The noun that agrees with a count: "case" for 1, "cases" otherwise.
export const pluralText = (
  count: number,
  singular: string,
  plural: string,
): string => sharedPluralText(count, singular, plural);

// A count and its noun: "1 case", "5 cases".
export const countText = (
  count: number,
  singular: string,
  plural: string,
): string => sharedCountText(count, singular, plural);

// Items joined with ", ", at most five of them, then " (+N more)".
export const listText = (items: readonly string[], max?: number): string =>
  max === undefined ? sharedListText(items) : sharedListText(items, max);

const lineBreaks = /[\n\r]+/u;

// Any error on one line: a response a schema refused as
// `unexpected response: <path>: <message>` per issue, joined by "; ";
// any other error by its message, its lines joined by a space.
export const errorText = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    return `unexpected response: ${issuesText(error.issues)}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(lineBreaks)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
};

type SummaryIo = { readonly stdout: (text: string) => void };

// A command's summary on stdout: one JSON document, indented by two
// spaces, written in one call.
export const printSummary = (io: SummaryIo, value: unknown): void => {
  io.stdout(JSON.stringify(value, null, 2));
};
