import { describe, expect, test } from 'vitest';

import { teachingInputs } from '../directus/extensions/directus-extension-data-operations/src/teaching-rebuild.js';
import { slotsOf } from '../directus/extensions/directus-extension-data-operations/src/teaching/parse.js';
import { matchSlotsSql } from '../directus/extensions/directus-extension-data-operations/src/teaching/sql.js';

const named = (...names: string[]) =>
  names.map((name, index) => ({ id: String(index), name }));

const card = {
  classes: named('4y-SEIS', '4г-СИИС'),
  classrooms: named('315 ТМФ'),
  dayIndex: 0,
  durationPeriods: 2,
  endTime: '09:45',
  startTime: '08:10',
  subject: { name: 'Машинска визија (п)' },
  teachers: named('Андреа Кулаков', 'Ивица Димитровски'),
};

describe('timetable slots', () => {
  test('keep each card with its day, times, teachers, classes and classroom', () => {
    expect(slotsOf({ cards: [card] })).toEqual([
      {
        classroom: '315 ТМФ',
        day: 1,
        ends: '09:45',
        groups: '4y-SEIS, 4г-СИИС',
        kind: 'п',
        periods: 2,
        starts: '08:10',
        subject: 'Машинска визија',
        teachers: 'Андреа Кулаков, Ивица Димитровски',
      },
    ]);
  });

  test('give a card one slot per classroom, and one without a classroom when it has none', () => {
    const twoRooms = { ...card, classrooms: named('Б 2.1', 'Б 2.2') };
    const noRoom = {
      ...card,
      classes: [],
      classrooms: [],
      teachers: [],
    };

    expect(
      slotsOf({ cards: [twoRooms] }).map(({ classroom }) => classroom),
    ).toEqual(['Б 2.1', 'Б 2.2']);
    expect(slotsOf({ cards: [noRoom] })).toEqual([
      expect.objectContaining({
        classroom: null,
        groups: null,
        teachers: null,
      }),
    ]);
  });

  test('match a classroom by name and location either way round, then by name, through room aliases first', () => {
    expect(matchSlotsSql).toContain(`r."name" || ' ' || r."location"`);
    expect(matchSlotsSql).toContain(`r."location" || ' ' || r."name"`);
    expect(matchSlotsSql).toContain('JOIN "room_aliases" a');
    expect(matchSlotsSql).toContain('HAVING count(DISTINCT c."course") = 1');
  });

  test('rebuild after an edit of a room or a room alias', () => {
    expect(teachingInputs).toEqual(
      expect.arrayContaining(['rooms', 'room_aliases']),
    );
  });
});
