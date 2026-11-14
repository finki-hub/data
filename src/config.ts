import { loadTargetConfig, SetupConfigError } from './setup-config.js';
import { listText, pluralText } from './text.js';

export type DirectusConfig = {
  readonly token: string;
  readonly url: URL;
};

// `<fact> argument[s]: <list>`, such as `unexpected argument: --x`.
const argumentsFact = (fact: string, names: readonly string[]): string =>
  `${fact} ${pluralText(names.length, 'argument', 'arguments')}: ${listText(names)}`;

// Refuses every argument outside `accepted` and every accepted one given
// more than once, one fact each, joined by "; ":
// `unexpected argument: --x (accepted: none)`.
const refuseArguments = (
  arguments_: readonly string[],
  accepted: readonly string[],
): void => {
  const unexpected = [
    ...new Set(arguments_.filter((argument) => !accepted.includes(argument))),
  ];
  const duplicate = accepted.filter(
    (name) => arguments_.filter((argument) => argument === name).length > 1,
  );
  const facts = [
    ...(unexpected.length === 0
      ? []
      : [
          `${argumentsFact('unexpected', unexpected)} (accepted: ${accepted.length === 0 ? 'none' : accepted.join(', ')})`,
        ]),
    ...(duplicate.length === 0 ? [] : [argumentsFact('duplicate', duplicate)]),
  ];
  if (facts.length > 0) {
    throw new SetupConfigError(facts.join('; '));
  }
};

// The branding command's configuration. It takes no argument; its target
// comes from the environment, which npm run brand completes from .env,
// with the local project as the default URL.
export const loadBrandingConfig = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): DirectusConfig => {
  refuseArguments(arguments_, []);
  return loadTargetConfig(environment, {
    defaultUrl: 'http://localhost:8055',
    readsEnvFile: true,
  });
};
