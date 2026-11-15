import { describe, expect, test } from 'vitest';

import {
  programStates,
  roomLocations,
  roomTypes,
  staffPositions,
} from '../src/data-model/choice-lists.js';
import { dataModelCollections } from '../src/data-model/collections.js';
import {
  enumChoiceMeta,
  enumMaxLength,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { choiceValues } from '../src/data-model/fields.js';
import { installDataModel } from '../src/data-model/install.js';
import { valuesOutside } from '../src/data-model/plan-choices.js';
import { aliasesFor } from '../src/data-model/relations.js';
import {
  fakeDirectus,
  findField,
  installedState,
  mutations,
} from './data-model-test-helpers.js';

const enumOf = (collection: string, field: string) => {
  const found = findField(collection, field);
  if (found.kind !== 'enum') {
    throw new Error(`${collection}.${field} is not an enum`);
  }
  return found;
};

// `collection.field` and the choices of every allow-other field.
const allowOtherFields = dataModelCollections.flatMap(
  ({ collection, fields }) =>
    fields.flatMap((field) =>
      field.kind === 'enum' && field.allowOther === true
        ? [{ choices: field.choices, name: `${collection}.${field.field}` }]
        : [],
    ),
);

const totalFields = dataModelCollections.reduce(
  (sum, { collection, fields }) =>
    sum + fields.length + aliasesFor(collection).length,
  0,
);

// A Studio user's edits of the field's form, which setup never writes.
const studioEdits = { note: 'Synthetic Studio note', width: 'full' };

// An installed project whose staff.position is still a closed dropdown of
// an earlier, shorter vocabulary, and holds a value outside it.
const closedPosition = () => {
  const state = installedState();
  const earlier = [{ text: 'Доцент', value: 'Доцент' }];
  state.fields['staff'] = (state.fields['staff'] ?? []).map((field) =>
    field.field === 'position'
      ? {
          ...field,
          meta: {
            ...field.meta,
            ...studioEdits,
            display_options: { choices: earlier },
            options: {
              allowNone: false,
              allowOther: false,
              choices: earlier,
              placeholder: 'Synthetic placeholder',
            },
            validation: { position: { _in: ['Доцент'] } },
          },
        }
      : field,
  );
  state.values = { 'staff.position': ['Доцент', 'Synthetic Position'] };
  return state;
};

describe('choice lists', () => {
  test('hold the vocabularies of today, each value labelled with itself', () => {
    expect(choiceValues(enumOf('staff', 'position'))).toEqual([
      'Редовен професор',
      'Вонреден професор',
      'Доцент',
      'Асистент докторанд',
      'Демонстратор',
      'Секретар',
      'Технички секретар',
      'Советник во одделение за ИКТ',
      'Насловен вонреден професор',
      'Визитинг професор',
      'Професор во пензија',
      'Надворешен соработник',
    ]);
    expect(choiceValues(enumOf('rooms', 'type'))).toEqual([
      'Кабинет',
      'Предавална',
      'Лабораторија',
      'Амфитеатар',
      'Сала',
      'Канцеларија',
      'Деканат',
      'PVC Кутија',
    ]);
    expect(choiceValues(enumOf('rooms', 'location'))).toEqual([
      'ТМФ',
      'Анекс на МФ',
      'МФ',
      'Анекс на ФЕИТ',
      'Бараки',
      'ФИНКИ',
      'ПФ',
      'ФЕИТ',
    ]);
    expect(
      choiceValues(enumOf('curriculum_entry_program_states', 'state')),
    ).toEqual(['задолжителен', 'изборен', 'нема']);

    expect(
      allowOtherFields
        .flatMap(({ choices }) => choices)
        .filter(({ label, value }) => label !== value),
    ).toEqual([]);
  });

  test('are the allow-other fields: three required published ones and the program state', () => {
    expect(allowOtherFields).toEqual([
      { choices: staffPositions, name: 'staff.position' },
      { choices: roomTypes, name: 'rooms.type' },
      { choices: roomLocations, name: 'rooms.location' },
      {
        choices: programStates,
        name: 'curriculum_entry_program_states.state',
      },
    ]);
    expect(
      [
        enumOf('staff', 'position'),
        enumOf('rooms', 'type'),
        enumOf('rooms', 'location'),
      ].map(({ nullable }) => nullable),
    ).toEqual([false, false, false]);
    expect(
      enumOf('curriculum_entry_program_states', 'state').nullable,
    ).toBeTruthy();
  });

  test('keep every closed choice within its varchar(64) column', () => {
    const closed = dataModelCollections
      .flatMap(({ fields }) => fields)
      .flatMap((field) =>
        field.kind === 'enum' && field.allowOther !== true
          ? choiceValues(field)
          : [],
      );

    expect(closed.length).toBeGreaterThan(0);
    expect(closed.filter((value) => value.length > enumMaxLength)).toEqual([]);
  });
});

describe('allow-other dropdowns', () => {
  test('take other values, show them as stored and carry no rule or length limit', () => {
    const payload = toFieldPayload(enumOf('staff', 'position'), 4);
    const choices = staffPositions.map(({ value }) => ({ text: value, value }));

    expect(payload).toMatchObject({
      field: 'position',
      meta: {
        display: 'labels',
        display_options: { choices, format: false },
        interface: 'select-dropdown',
        options: { allowNone: false, allowOther: true, choices },
        required: true,
        validation: null,
      },
      schema: { is_nullable: false },
      type: 'string',
    });
    expect(payload.schema).not.toHaveProperty('max_length');
    expect(
      enumChoiceMeta(enumOf('curriculum_entry_program_states', 'state')),
    ).toMatchObject({
      options: { allowNone: true, allowOther: true },
      validation: null,
    });
  });

  test('accept every stored value, while a closed field names those outside', () => {
    const live = ['Доцент', null, 'Synthetic Position'];

    expect(valuesOutside(enumOf('staff', 'position'), live)).toEqual([]);
    expect(
      valuesOutside(enumOf('teaching_assignments', 'role'), [
        'professor',
        null,
        'lecturer',
      ]),
    ).toEqual(['lecturer']);
  });

  test('realign over a closed earlier vocabulary holding an unlisted value: no refusal, rule cleared', async () => {
    const { request, requests } = fakeDirectus(closedPosition());

    const summary = await installDataModel(request);
    const declared = enumChoiceMeta(enumOf('staff', 'position'));

    expect(mutations(requests)).toEqual([
      {
        body: {
          meta: {
            display_options: declared.display_options,
            options: {
              ...declared.options,
              placeholder: 'Synthetic placeholder',
            },
            validation: null,
          },
        },
        method: 'PATCH',
        pathname: '/fields/staff/position',
      },
    ]);
    expect(summary.fields).toMatchObject({
      adopted: 0,
      aligned: 1,
      refused: 0,
      skipped: totalFields - 1,
    });
    expect(
      requests.filter(({ pathname }) => pathname.startsWith('/items/')),
    ).toEqual([]);
  });
});
