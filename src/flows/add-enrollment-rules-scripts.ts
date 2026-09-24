import { courseTemplate } from '../data-model/checkpoint-collections.js';
import { academicYearTemplate } from '../data-model/curriculum-collections.js';
import { mappedRuleMode, scriptText } from './shared.js';

// The input of "Data / Add enrollment rules": its manual trigger with the
// confirmation and the two dialog fields (Studio's item pickers of an
// academic year and a course), and its Run Script bodies. Each runs in the
// isolated Directus script sandbox (no imports, no services, the whole
// data chain as `data`) and answers ids and counts only. The unit suite
// runs them in node:vm.

// The most rules one native Create writes.
export const ruleBatchSize = 250;

// The scope the dialog (or a REST caller) names: an academic year (every
// course for it), a course (every academic year for it) or both (one
// pair). Studio's item picker answers { key, collection }, a REST caller
// may send the id; anything else is refused before anything is read. The
// answer holds the native filters of the three reads.
export const scopeScript = `module.exports = function (data) {
  const trigger = data.$trigger !== null && typeof data.$trigger === 'object' ? data.$trigger : {};
  const body = trigger.body !== null && typeof trigger.body === 'object' ? trigger.body : {};
  const idOf = function (value, collection, label) {
    let raw = value;
    if (value !== null && typeof value === 'object') {
      if (value.collection !== undefined && value.collection !== collection) {
        throw new Error(label + ' must be a row of ' + collection + ', not of ' + String(value.collection) + '.');
      }
      raw = value.key;
    }
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-9][0-9]{0,14}$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error(label + ' must be the id of one ' + collection + ' row.');
    }
    return id;
  };
  const year = idOf(body.academic_year, 'academic_years', 'The academic year');
  const course = idOf(body.course, 'courses', 'The course');
  if (year === null && course === null) {
    throw new Error('Choose an academic year (every course for it), a course (every academic year for it) or both (one pair); nothing was created.');
  }
  const only = function (id) {
    return id === null ? { id: { _nnull: true } } : { id: { _eq: id } };
  };
  const rules = [];
  if (year !== null) {
    rules.push({ academic_year: { _eq: year } });
  }
  if (course !== null) {
    rules.push({ course: { _eq: course } });
  }
  return { course: course, courses: only(course), rules: { _and: rules }, year: year, years: only(year) };
};`;

// The missing (course, academic year) pairs of the scope: every course and
// year it names less the pairs that already have a rule of any mode (a
// legacy_regex rule is kept as it is). The pairs are cut into batches of
// at most ruleBatchSize rules of the declared mapped mode. A named year or
// course that does not exist is refused.
export const pairsScript = `module.exports = function (data) {
  const scope = data.scope;
  const ids = function (rows) {
    return Array.isArray(rows) ? rows.map(function (row) { return row.id; }) : [];
  };
  const years = ids(data.years);
  const courses = ids(data.courses);
  if (scope.year !== null && years.length === 0) {
    throw new Error('No academic year has id ' + scope.year + '; nothing was created.');
  }
  if (scope.course !== null && courses.length === 0) {
    throw new Error('No course has id ' + scope.course + '; nothing was created.');
  }
  const existing = new Set((Array.isArray(data.rules) ? data.rules : []).map(function (rule) {
    return rule.course + ':' + rule.academic_year;
  }));
  const missing = [];
  for (const course of courses) {
    for (const year of years) {
      if (!existing.has(course + ':' + year)) {
        missing.push({ academic_year: year, course: course, mode: ${scriptText(mappedRuleMode.mode)} });
      }
    }
  }
  const batches = [];
  for (let start = 0; start < missing.length; start += ${String(ruleBatchSize)}) {
    batches.push(missing.slice(start, start + ${String(ruleBatchSize)}));
  }
  return { batches: batches, courses: courses.length, existing: existing.size, missing: missing.length, years: years.length };
};`;

// Every batch answered { ok: true, created: [ids] }: the total. A batch
// that failed (a concurrent run created one of its pairs first, say) is
// refused with its code; the batches before it stay created, and a rerun
// skips them.
export const tallyScript = `module.exports = function (data) {
  const batches = Array.isArray(data.pairs.batches) ? data.pairs.batches : [];
  const results = Array.isArray(data.create_batches) ? data.create_batches : [];
  let created = 0;
  const failed = [];
  batches.forEach(function (batch, index) {
    const result = results[index];
    if (result !== null && typeof result === 'object' && result.ok === true && Array.isArray(result.created)) {
      created += result.created.length;
    } else {
      const code = result !== null && typeof result === 'object' && typeof result.code === 'string' ? result.code : 'NO_ANSWER';
      failed.push('batch ' + (index + 1) + ' of ' + batches.length + ' (' + batch.length + ' rules): ' + code);
    }
  });
  if (failed.length > 0) {
    throw new Error('Created ' + created + ' rules, then ' + failed.join('; ').slice(0, 400) + '. Run Data / Add enrollment rules again: existing pairs are skipped.');
  }
  return { batches: batches.length, created: created };
};`;

// The manual trigger: a button on Data Operations whose dialog names the
// scope. The API ignores the dialog, so scopeScript validates the input.
export const ruleSeedingOptions = {
  async: false,
  collections: ['data_operations'],
  confirmationDescription: `Create the missing enrollment rules (mode ${mappedRuleMode.mode}) for the academic year below (every course), the course below (every academic year), or both (one pair)? Existing rules of any mode stay as they are and no mapping is created; the new rules are counted within about 15 seconds.`,
  error_on_reject: true,
  fields: [
    {
      field: 'academic_year',
      meta: {
        interface: 'collection-item-dropdown',
        note: 'Every course gets a rule for this year.',
        options: {
          selectedCollection: 'academic_years',
          template: academicYearTemplate,
        },
        width: 'half',
      },
      name: 'Academic year',
      type: 'json',
    },
    {
      field: 'course',
      meta: {
        interface: 'collection-item-dropdown',
        note: 'This course gets a rule for every academic year.',
        options: { selectedCollection: 'courses', template: courseTemplate },
        width: 'half',
      },
      name: 'Course',
      type: 'json',
    },
  ],
  location: 'both',
  requireConfirmation: true,
  requireSelection: false,
} as const;
