import { pageSize } from './limits.js';

const englishPlurals = new Intl.PluralRules('en');

// A count with its noun as the Search UI shows it: the singular for exactly
// one and the plural for every other count, zero included.
export const countText = (
  count: number,
  singular: string,
  plural: string,
): string =>
  `${count.toLocaleString()} ${englishPlurals.select(count) === 'one' ? singular : plural}`;

// The users a page shows out of every match, each number localized:
// "1,001–1,050 of 1,234".
export const rangeText = (page: number, total: number): string => {
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`;
};
