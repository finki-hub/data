import { defineHook } from '@directus/extensions-sdk';

import { defaultPattern, defaultYearPattern } from './enrollment-lines.js';

// The alias of a course's pattern mappings, written as a nested O2M list.
const alias = 'pattern_mappings';

type Payload = Readonly<Record<string, unknown>>;

const isPayload = (value: unknown): value is Payload =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type DefaultMapping = {
  readonly pattern: string;
  readonly year_pattern: string;
};

// Whether a nested row creates exactly the default mapping: no id, the
// default pattern, no year, and the default year pattern, sent or left to
// the column default. The unique key would refuse a second one.
const isDefault = (item: unknown, { pattern }: DefaultMapping): boolean => {
  if (!isPayload(item) || 'id' in item || item['pattern'] !== pattern) {
    return false;
  }
  const year = item['only_in_year'] ?? null;
  const yearPattern =
    'year_pattern' in item ? item['year_pattern'] : defaultYearPattern;
  return year === null && yearPattern === defaultYearPattern;
};

const withDefault = (
  creates: readonly unknown[],
  mapping: DefaultMapping,
): readonly unknown[] =>
  creates.some((item) => isDefault(item, mapping))
    ? creates
    : [...creates, mapping];

// The create payload of a course with its default pattern mapping as a
// nested create (decision C), which Directus writes in the transaction
// that creates the course:
// - without mappings, the default is the one nested create;
// - with mappings to create (an array, or Studio's {create, update,
//   delete}), the default is added unless one of them already is it;
// - an explicitly empty list loses the key and gains nothing (the import
//   writes every course's mappings itself).
// A payload without a name is left as it is; the database refuses it.
export const withDefaultMapping = (payload: unknown): unknown => {
  if (!isPayload(payload) || typeof payload['name'] !== 'string') {
    return payload;
  }
  const mapping = {
    pattern: defaultPattern(payload['name']),
    year_pattern: defaultYearPattern,
  };
  const mappings = payload[alias];
  if (Array.isArray(mappings) && mappings.length === 0) {
    return Object.fromEntries(
      Object.entries(payload).filter(([field]) => field !== alias),
    );
  }
  if (Array.isArray(mappings)) {
    return { ...payload, [alias]: withDefault(mappings, mapping) };
  }
  if (isPayload(mappings)) {
    const creates = Array.isArray(mappings['create']) ? mappings['create'] : [];
    return {
      ...payload,
      [alias]: { ...mappings, create: withDefault(creates, mapping) },
    };
  }
  return { ...payload, [alias]: [mapping] };
};

// Only creates: a renamed course keeps its mappings, because Moodle's
// older lines keep the old name.
export const registerCourseDefaultMapping = (
  filter: (event: string, handler: (payload: unknown) => unknown) => void,
): void => {
  filter('courses.items.create', withDefaultMapping);
};

export default defineHook(({ filter }) => {
  registerCourseDefaultMapping(filter);
});
