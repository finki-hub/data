// The enrollment rule modes (course_enrollment_rules.mode), declared once:
// the model enum and its labels, the Studio notes, the mode the import
// seeds and the mode Add enrollment rules creates read this list. No Flow
// counts a rule: the enrollment counts come from pattern and explicit
// mappings. This module imports nothing.

// One declared mode: the stored value and its Studio label, what a rule of
// the mode stood for (the field notes) and whether it reads `pattern`.
export type RuleModeSpec = {
  readonly description: string;
  readonly label: string;
  readonly mode: string;
  readonly usesPattern: boolean;
};

export const ruleModes = [
  {
    description: 'counts explicit mappings',
    label: 'Mapped entries',
    mode: 'mapped_entries',
    usesPattern: false,
  },
  {
    description: 'applies the retained pattern',
    label: 'Legacy regex',
    mode: 'legacy_regex',
    usesPattern: true,
  },
] as const satisfies readonly RuleModeSpec[];

type Declared = (typeof ruleModes)[number];

type RuleModeName = Declared['mode'];

// The declaration of one mode.
export const ruleMode = <Name extends RuleModeName>(
  name: Name,
): Extract<Declared, { readonly mode: Name }> => {
  const found = ruleModes.find(
    (entry): entry is Extract<Declared, { readonly mode: Name }> =>
      entry.mode === name,
  );
  if (found === undefined) {
    throw new Error(`Rule mode ${name} is not declared`);
  }
  return found;
};
