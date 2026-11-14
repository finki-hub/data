import { describe, expect, test } from 'vitest';

import {
  dataModelCollections,
  findModelCollection,
} from '../src/data-model/collections.js';
import { toCollectionPayload } from '../src/data-model/install.js';
import { presentationFieldPatches } from '../src/data-model/presentation/fields.js';
import { fieldGroups } from '../src/data-model/presentation/groups.js';
import { folders } from '../src/data-model/presentation/navigation.js';
import { presetDefinitions } from '../src/data-model/presentation/presets.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { effectiveFieldMeta } from './presentation-test-helpers.js';

// The Studio notes: only where a label cannot carry a rule, each one or two
// short sentences. Every other collection, field, alias, presentation and
// group note is gone. A sidebar folder has no note at all (`Folder`
// declares none; presentation.test.ts checks the folder bodies).

// The model fields and aliases of a collection, in installation order.
const fieldsOf = (collection: string): readonly string[] => {
  const model = findModelCollection(collection);
  return model === undefined
    ? []
    : [
        ...model.fields.map(({ field }) => field),
        ...aliasesFor(model.collection).map(({ alias }) => alias.field),
      ];
};

// Every note a fresh project shows, as `<place>: <note>` in model order:
// the collection's, then each field's and alias's (the installer's meta
// with the presentation patch over it), then each form group's.
const declaredNotes = (): readonly string[] =>
  dataModelCollections.flatMap((model) => {
    const { collection } = model;
    const { meta } = toCollectionPayload(model);
    return [
      ...(meta.note === undefined ? [] : [`${collection}: ${meta.note}`]),
      ...fieldsOf(collection).flatMap((field) => {
        const { note } = effectiveFieldMeta(collection, field);
        return typeof note === 'string'
          ? [`${collection}.${field}: ${note}`]
          : [];
      }),
      ...fieldGroups
        .filter((group) => group.collection === collection)
        .flatMap(({ field, note }) =>
          note === undefined ? [] : [`${collection} group ${field}: ${note}`],
        ),
    ];
  });

const remainingNotes = [
  'courses.status: All professors publishes "Сите професори" as professors. Inactive publishes "(неактивиран предмет)" as professors and assistants.',
  'courses.pattern_mappings: A new course gets <name>- with the default year pattern. A renamed course keeps its mappings; a new Moodle name needs its own pattern.',
  'exam_sessions.file: The PDF or Excel schedule, published under its file name.',
  'curriculum_entries.code: The digit after L is the level: F18L3W055 is level 3.',
  "curriculum_entries.channel: Published as channel. Independent of the course's Discord channel.",
  "curriculum_entries.program_states: Programs of the entry's generation; locked until a generation is set. The fields below State edit the program itself.",
  "course_curricula.entry: Entries of the row's generation only; locked until a generation is set.",
  "curriculum_generations.code: Prefixes the generation's keys in courses.json, such as 2023-name.",
  'curriculum_generations.has_curriculum: Off for a generation known only from equivalency labels, such as 2013.',
  "study_programs.code: Names the program's state key in courses.json, such as 2023-state-kn.",
  "course_equivalency_members.entry: Entries of the row's generation only; locked until a generation is set.",
  'moodle_import_rows: Written only by the Moodle snapshot import; nothing else reads it.',
  'moodle_course_entries.first_seen: When the history index first created this line.',
  'moodle_course_entries.mappings: An explicit mapping replaces every pattern for this line.',
  'moodle_pattern_mappings.pattern: Regular expression tested against each history line; ^ matches the start of the line.',
  'moodle_pattern_mappings.year_pattern: Group start or end captures the year the academic year starts or ends, in 2 or 4 digits (2 digits mean 20xx). A line without such a year is not counted.',
  "moodle_pattern_mappings.only_in_year: Counts the pattern only in this year, in place of the course's all-years mappings there.",
  'data_operations.claim_heartbeat_at: A stale heartbeat releases the claim as abandoned.',
  'data_operations.import_backup_file: Kept until deleted by hand.',
  'data_operations.import_promoted_fingerprint: Active rows that no longer match it were changed outside the snapshot import.',
  'data_operations group failure: Kept after later successes; blocks processing while the source and Flows are at its revision.',
];

// Every Studio name, note and template of the model and the presentation,
// by place: collections with their fields, aliases and choices, the field
// patches, form groups, sidebar folders and every bookmark.
const studioTexts = (): ReadonlyArray<readonly [string, unknown]> => [
  ...dataModelCollections.map(
    (model) => [model.collection, toCollectionPayload(model)] as const,
  ),
  ...presentationFieldPatches.map(
    (patch) => [`${patch.collection}.${patch.field}`, patch.meta] as const,
  ),
  ...fieldGroups.map(
    (group) => [`${group.collection} group ${group.field}`, group] as const,
  ),
  ...folders.map((folder) => [`folder ${folder.collection}`, folder] as const),
  ...presetDefinitions.map(
    (preset) =>
      [`preset ${preset.collection} ${preset.bookmark ?? ''}`, preset] as const,
  ),
];

const saysReview = /review/iu;

describe('the Studio notes', () => {
  test('are exactly the short notes a label cannot carry', () => {
    // Each patch is on a model field or alias, so its note is read above.
    expect(
      presentationFieldPatches
        .filter(
          ({ collection, field }) => !fieldsOf(collection).includes(field),
        )
        .map(({ collection, field }) => `${collection}.${field}`),
    ).toEqual([]);
    expect(declaredNotes()).toEqual(remainingNotes);
  });

  test('never say review, nor does any label, template, group, folder or bookmark name', () => {
    expect(
      studioTexts()
        .filter(([, text]) => saysReview.test(JSON.stringify(text)))
        .map(([place]) => place),
    ).toEqual([]);
  });
});
