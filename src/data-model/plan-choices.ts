import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type { ModelEnumField } from '../schema.js';

import { type ChoiceMeta, enumChoiceMeta } from './field-payloads.js';

const metaObject = z.record(z.string(), z.unknown());

// A meta column that holds an object, or an empty one.
const objectOf = (value: unknown): Readonly<Record<string, unknown>> => {
  const parsed = metaObject.safeParse(value);
  return parsed.success ? parsed.data : {};
};

// The choice meta an installed enum field must carry to match its
// declaration, merged over what Studio stored: `options` keeps every other
// option (a placeholder, an icon) and takes the declared choices,
// allowNone and allowOther; `display_options` keeps its other keys and
// takes the declared choices; `validation` is the declared membership rule
// (null for an allow-other field). Answers null when the field already
// carries exactly that, so a rerun on an aligned project writes nothing.
export const realignedChoices = (
  field: ModelEnumField,
  meta: Readonly<Record<string, unknown>>,
): ChoiceMeta | null => {
  const declared = enumChoiceMeta(field);
  const options = objectOf(meta['options']);
  const display = objectOf(meta['display_options']);
  const next: ChoiceMeta = {
    display_options: { ...display, ...declared.display_options },
    options: { ...options, ...declared.options },
    validation: declared.validation,
  };
  const aligned =
    isDeepStrictEqual(next.options, options) &&
    isDeepStrictEqual(next.display_options, display) &&
    isDeepStrictEqual(meta['validation'] ?? null, next.validation);
  return aligned ? null : next;
};

// The live values of a realigned field that its declaration no longer
// accepts (null is left to the column's nullability), in first-seen order.
// An allow-other field accepts every value.
export const valuesOutside = (
  field: ModelEnumField,
  live: readonly unknown[],
): readonly string[] => {
  if (field.allowOther === true) {
    return [];
  }
  const accepted = new Set<unknown>(field.choices.map(({ value }) => value));
  return [
    ...new Set(
      live
        .filter((value) => value !== null && !accepted.has(value))
        .map(String),
    ),
  ];
};
