import type { EnumChoice } from '../schema.js';

import { labelledChoices } from './fields.js';

// The short vocabularies of published text fields, as the workbook writes
// them today. Each choice is labelled with its own value, so Studio shows
// it exactly as staff.json, rooms.json and courses.json publish it. The
// fields allow other values: a list offers today's values and refuses
// none, so a new value is typed once and published as typed. The dean's
// office positions, which no file publishes, are a closed list instead.

// Choices whose label is the stored value.
export const verbatimChoices = (
  values: readonly string[],
): readonly EnumChoice[] => values.map((value) => ({ label: value, value }));

export const staffPositions = verbatimChoices([
  'Редовен професор',
  'Вонреден професор',
  'Доцент',
  'Асистент докторанд',
  'Демонстратор',
  'Секретар',
  'Технички секретар',
  'Советник во одделение за ИКТ',
]);

export const roomTypes = verbatimChoices([
  'Кабинет',
  'Предавална',
  'Лабораторија',
  'Амфитеатар',
  'Сала',
  'Канцеларија',
  'Деканат',
  'PVC Кутија',
]);

export const roomLocations = verbatimChoices([
  'ТМФ',
  'Анекс на МФ',
  'МФ',
  'Анекс на ФЕИТ',
  'Бараки',
  'ФИНКИ',
  'ПФ',
  'ФЕИТ',
]);

// The state of a curriculum entry in a study program. A qualified state
// such as "задолжителен (4 г.)" is another value, stored as written.
export const programStates = verbatimChoices([
  'задолжителен',
  'изборен',
  'нема',
]);

// The four positions of the dean's office, stored as the workbook writes
// them and labelled in English. The list is closed: a term is keyed by its
// year and position (deans_office_year_position_unique).
export const deanPositions = labelledChoices(
  [
    'Декан',
    'Продекан за настава',
    'Продекан за наука и соработка',
    'Продекан за финансии',
  ],
  {
    Декан: 'Dean',
    'Продекан за настава': 'Vice-dean for teaching',
    'Продекан за наука и соработка': 'Vice-dean for science and cooperation',
    'Продекан за финансии': 'Vice-dean for finance',
  },
);
