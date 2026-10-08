import { field, requiredField, type WorkbookSpec } from '../schema.js';

const curriculumBaseFields = [
  // Column A is merged over each semester block, its label in the block's
  // top cell: every row of the block reads that label.
  {
    ...field('Семестар', 'catalog_order', 'integer'),
    fillMerged: true,
    sourceColumn: 1,
  },
  requiredField('Предмет', 'name'),
  field('Линк', 'url', 'text'),
  // The level is the one the code gives (codeLevel), so the Ниво column
  // beside it is not read.
  field('Код', 'code'),
  { ...field('Семестар', 'semester', 'integer'), sourceColumn: 6 },
  field('Предуслови', 'prerequisites', 'text'),
] as const;

// The two curriculum sheets name their study-program columns by position:
// the header of each program column is read for its program code
// (src/workbook-program-reader.ts), and each cell becomes a program state.
export const referenceWorkbookSpecs = [
  {
    fields: [
      ...curriculumBaseFields,
      { ...field('КН', 'state_kn'), sourceColumn: 8 },
      { ...field('СИИС', 'state_siis'), sourceColumn: 9 },
      { ...field('ПИТ', 'state_pit'), sourceColumn: 10 },
      { ...field('ИМБ', 'state_imb'), sourceColumn: 11 },
      { ...field('КИ', 'state_ki'), sourceColumn: 12 },
      { ...field('ИЕ', 'state_ie'), sourceColumn: 13 },
      { ...field('ССП', 'state_ssp'), sourceColumn: 14 },
      { ...field('SEIS', 'state_seis'), sourceColumn: 15 },
      { ...field('Канал', 'channel', 'boolean'), sourceColumn: 16 },
    ],
    key: 'curriculum_2023',
    source: { kind: 'rows', sheet: 'Предмети - 2023' },
  },
  {
    fields: [
      ...curriculumBaseFields,
      { ...field('КН', 'state_kn'), sourceColumn: 8 },
      { ...field('СИИС', 'state_siis'), sourceColumn: 9 },
      { ...field('ПИТ', 'state_pit'), sourceColumn: 10 },
      { ...field('ИМБ', 'state_imb'), sourceColumn: 11 },
      { ...field('КИ', 'state_ki'), sourceColumn: 12 },
      { ...field('КЕ', 'state_ke'), sourceColumn: 13 },
      { ...field('SEIS', 'state_seis'), sourceColumn: 14 },
      { ...field('Канал', 'channel', 'boolean'), sourceColumn: 15 },
    ],
    key: 'curriculum_2018',
    source: { kind: 'rows', sheet: 'Предмети - 2018' },
  },
  {
    fields: [
      field('Предмет (2023)', 'course_2023'),
      field('Предмет (2018)', 'course_2018'),
      field('Предмет (2013)', 'course_2013'),
    ],
    key: 'course_equivalencies',
    source: { kind: 'rows', sheet: 'Еквиваленции' },
  },
  {
    fields: [
      requiredField('Предмет', 'course_name'),
      field('Професори', 'professors', 'text'),
      field('Асистенти', 'assistants', 'text'),
    ],
    key: 'teaching_assignments',
    source: { kind: 'rows', sheet: 'Наставен Кадар' },
  },
  {
    fields: [
      requiredField('course_name', 'course_name'),
      requiredField('academic_year', 'academic_year'),
      requiredField('pattern', 'pattern', 'text'),
    ],
    key: 'course_enrollment_patterns',
    source: {
      kind: 'course-enrollment-patterns',
      sheet: 'Слушатели',
    },
  },
  {
    fields: [
      requiredField('semester', 'semester', 'integer'),
      requiredField('channel', 'channel'),
      requiredField('course_names', 'course_names', 'text'),
    ],
    key: 'discord_channels',
    source: { endRow: 29, kind: 'discord-pairs', sheet: 'Дискорд' },
  },
  {
    fields: [
      { ...requiredField('Година', 'year', 'integer'), fillDown: true },
      requiredField('Индекс', 'index_number'),
      requiredField('Смер', 'position'),
    ],
    key: 'student_council',
    source: { kind: 'rows', sheet: 'ФСС' },
  },
  {
    fields: [
      { ...requiredField('Година', 'year', 'integer'), fillDown: true },
      requiredField('Име', 'name'),
      requiredField('Функција', 'position'),
    ],
    key: 'deans_office',
    source: { kind: 'rows', sheet: 'Деканат' },
  },
] as const satisfies readonly WorkbookSpec[];
