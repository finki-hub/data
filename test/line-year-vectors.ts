import { defaultYearPattern } from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';

// The year rule's vectors: a year pattern, a history line, and the
// academic year the pattern reads from the line (null: none). lineYear and
// the matcher Run Script are both run on them.
export const lineYearVectors: ReadonlyArray<
  readonly [yearPattern: string, label: string, year: null | string]
> = [
  // Both groups, consecutive.
  [defaultYearPattern, 'Математика 1-2025/2026/Z', '2025/2026'],
  [
    defaultYearPattern,
    'Основи на сајбер безбедноста / Cybersecurity fundamentals - 2025/2026/L',
    '2025/2026',
  ],
  [defaultYearPattern, 'Систем-1999/2000/Z', '1999/2000'],
  [
    String.raw`(?<start>\d{4})-(?<end>\d{4})`,
    'Професионални вештини 2026-2027',
    '2026/2027',
  ],
  [
    String.raw`(?<start>\d{4})(?<end>\d{4})`,
    'Introduction to Computer Science-20252026-Z',
    '2025/2026',
  ],
  // Both groups, not consecutive.
  [defaultYearPattern, 'Бази на податоци-2025/2027/Z', null],
  [defaultYearPattern, 'Бази на податоци-2025/2024/Z', null],
  [defaultYearPattern, 'Бази на податоци-2025/2025/Z', null],
  // The first match wins when a line holds two years.
  [defaultYearPattern, 'Физика-2024/2025-2025/2026/Z', '2024/2025'],
  [String.raw`(?<start>\d{4})`, 'Физика 2019 (2020/2021)', '2019/2020'],
  // start only, end only.
  [
    String.raw`(?<start>\d{4})`,
    'Стручни студии – Структурно програмирање - 2024',
    '2024/2025',
  ],
  [String.raw`(?<end>\d{4})`, 'Системи на знаење-2025', '2024/2025'],
  // 2-digit years mean 20xx, alone or beside 4 digits.
  [
    String.raw`(?<start>\d{4})/(?<end>\d{2})`,
    'Автономна роботика-2024/25',
    '2024/2025',
  ],
  [
    String.raw`(?<start>\d{4})/(?<end>\d{2})`,
    'Автономна роботика-2024/26',
    null,
  ],
  [String.raw`(?<start>\d{2})/(?<end>\d{2})`, 'КА-21/22', '2021/2022'],
  [String.raw`(?<start>\d{2})/(?<end>\d{4})`, 'КА-25/2026', '2025/2026'],
  [String.raw`(?<end>\d{2})`, 'КА-26', '2025/2026'],
  [String.raw`(?<start>\d{2})`, 'КА-99', '2099/2100'],
  // A capture of another form.
  [String.raw`(?<start>\d{3})`, 'Физика-202', null],
  [String.raw`(?<start>\d+)`, 'Физика-20255', null],
  [String.raw`(?<start>\d*)`, 'Физика', null],
  [String.raw`(?<start>\w{4})`, 'Name-2025', null],
  [String.raw`(?<start>\p{Nd}{4})`, 'Физика-٢٠٢٥', null],
  [String.raw`(?<start>\d{4})|(?<end>x)`, 'Физика-x-2025', null],
  // No match.
  [defaultYearPattern, 'Апсолвенти ФИНКИ', null],
  [defaultYearPattern, 'ВЕЗИЛКА', null],
  // A group that did not take part.
  [String.raw`-(?:(?<start>\d{4})|Z)`, 'Физика-Z-2025', null],
  [String.raw`(?<start>\d{4})(?:/(?<end>\d{4}))?`, 'Физика-2025', '2025/2026'],
  [String.raw`(?<start>\d{4})(?:/(?<end>\d{4}))?`, 'Физика-2025/2027', null],
];
