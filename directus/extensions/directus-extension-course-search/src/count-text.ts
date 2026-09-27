const englishPlurals = new Intl.PluralRules('en');

// A count with its noun as the Search UI shows it: the singular for exactly
// one and the plural for every other count, zero included.
export const countText = (
  count: number,
  singular: string,
  plural: string,
): string =>
  `${count.toLocaleString()} ${englishPlurals.select(count) === 'one' ? singular : plural}`;
