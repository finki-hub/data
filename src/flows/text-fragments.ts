import { pluralText } from '../../directus/extensions/directus-extension-data-operations/src/text.js';

// The text forms the Flow templates share. A Run Script runs sandboxed and
// cannot import, so its forms are source fragments interpolated into the
// script body; descriptions and operation names are built here.

// The longest relayed failure a Run Script answers or throws: below the
// 600 characters the coordinator stores, so a chain of relays is cut once,
// at its end.
export const relayBound = 500;

// Run Script source defining `refuse(place, fault)`, which throws the leaf
// form `<place>: <fault>`. A step-answer check names the step key as the
// place: refuse('read_plan', 'expected 1 status row').
export const refuseFragment =
  "const refuse = function (place, fault) { throw new Error(String(place) + ': ' + String(fault)); };";

// Run Script source defining `relayed(subject, failure)`, which answers the
// relay form `<Subject> failed [<stage> <CODE>]: <message>` of a child's
// failure record {stage, code, message} (`[<CODE>]` for a record without
// a stage), cut to relayBound characters.
export const relayFragment = `const relayed = function (subject, failure) { const record = failure !== null && typeof failure === 'object' ? failure : {}; const stage = typeof record.stage === 'string' && record.stage.length > 0 ? record.stage + ' ' : ''; return (String(subject) + ' failed [' + stage + String(record.code) + ']: ' + String(record.message)).slice(0, ${String(relayBound)}); };`;

// Run Script source defining `counted(count, singular, plural)`, the
// count form `1 row`, `5 rows` (countText of the extension's text.ts).
export const countFragment =
  "const counted = function (count, singular, plural) { return String(count) + ' ' + (count === 1 ? singular : plural); };";

const keysText = (keys: readonly string[]): string => `{${keys.join(', ')}}`;

// Run Script source of the statement that refuses a trigger payload:
// `Invalid trigger payload: expected {<keys>}`.
export const payloadRefusal = (keys: readonly string[]): string => {
  const message = `Invalid trigger payload: expected ${keysText(keys)}`;
  return `throw new Error(${JSON.stringify(message)});`;
};

// What a failing Flow answers besides its result: the failure record
// {ok: false, stage, code, message} with the context keys the Flow adds
// (such as page), and the codes it fails with; or no rejection at all.
type FlowFailure =
  | 'never rejects'
  | {
      readonly codes?: readonly string[];
      readonly context?: readonly string[];
    };

export type FlowDescriptionParts = {
  // The answer keys, such as 'ok: true', 'pages'.
  readonly answers?: readonly string[];
  // The Flow that runs this one.
  readonly caller?: string;
  // What the Flow does: `<Verb> <object>`.
  readonly does: string;
  readonly failure?: FlowFailure;
  // The trigger payload keys.
  readonly input?: readonly string[];
  // One more fact, after what the Flow does.
  readonly note?: string;
};

const sentence = (text: string): string =>
  text.endsWith('.') ? text : `${text}.`;

const failureText = (failure: FlowFailure | undefined): string => {
  if (failure === undefined) {
    return '';
  }
  if (failure === 'never rejects') {
    return '; never rejects';
  }
  const record = keysText([
    'ok: false',
    ...(failure.context ?? []),
    'stage',
    'code',
    'message',
  ]);
  const codes = failure.codes ?? [];
  return codes.length === 0
    ? ` or ${record}`
    : ` or ${record}; failure ${pluralText(codes.length, 'code', 'codes')} ${codes.join(', ')}`;
};

// A Flow description: `<Verb> <object>.[ <Fact>.] Input {...}. Answers
// {...} or {ok: false, stage, code, message}[; failure code X]. Called by
// "<Flow>".`
export const flowDescription = ({
  answers,
  caller,
  does,
  failure,
  input,
  note,
}: FlowDescriptionParts): string =>
  [
    sentence(does),
    ...(note === undefined ? [] : [sentence(note)]),
    ...(input === undefined ? [] : [`Input ${keysText(input)}.`]),
    ...(answers === undefined
      ? []
      : [`Answers ${keysText(answers)}${failureText(failure)}.`]),
    ...(caller === undefined ? [] : [`Called by "${caller}".`]),
  ].join(' ');

// The names of the failure-branch operations: the step that fails the
// claim, the transform that answers the failure record and the Throw Error
// step. The operation keys stay as they are.
export const stepName = {
  answerFailure: (stage: string): string => `Answer failure: ${stage}`,
  failClaim: (stage: string): string => `Fail claim: ${stage}`,
  raise: (code: string): string => `Throw ${code}`,
} as const;
