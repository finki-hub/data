import { describe, expect, test } from 'vitest';

import {
  countFragment,
  flowDescription,
  payloadRefusal,
  refuseFragment,
  relayBound,
  relayFragment,
  stepName,
} from '../src/flows/text-fragments.js';
import { refusalOf, runScript } from './flow-script-helpers.js';

// A Run Script body that holds the fragments and runs `body` over the
// data chain.
const script = (body: string): string => `module.exports = function (data) {
  ${refuseFragment}
  ${relayFragment}
  ${countFragment}
  ${body}
};`;

describe('Run Script fragments', () => {
  test('count as countText does: one noun for 1, the plural otherwise', () => {
    expect(
      runScript(
        script(
          "return [0, 1, 2].map(function (n) { return counted(n, 'row', 'rows'); });",
        ),
        {},
      ),
    ).toEqual(['0 rows', '1 row', '2 rows']);
  });

  test('refuse with the leaf form, place first', () => {
    expect(
      refusalOf(() =>
        runScript(
          script(
            "refuse('Page ' + data.token, 'revision ' + data.revision + ', expected 7');",
          ),
          { revision: 6, token: 'p0002' },
        ),
      ),
    ).toBe('Page p0002: revision 6, expected 7');
    expect(
      refusalOf(() =>
        runScript(script("refuse('read_plan', 'expected 1 status row');"), {}),
      ),
    ).toBe('read_plan: expected 1 status row');
  });

  test('relay a child failure record with its stage and code, cut to one bound', () => {
    const relay = script("return relayed('Page p0003', data.result);");

    expect(
      runScript(relay, {
        result: {
          code: 'MATCH_FAILED',
          message:
            'Pattern mapping 12: invalid regular expression (Unterminated group)',
          ok: false,
          stage: 'match',
        },
      }),
    ).toBe(
      'Page p0003 failed [match MATCH_FAILED]: Pattern mapping 12: invalid regular expression (Unterminated group)',
    );

    const long = runScript(relay, {
      result: { code: 'X', message: 'y'.repeat(900), stage: 'match' },
    });

    expect(long).toBe(
      'Page p0003 failed [match X]: '
        .concat('y'.repeat(900))
        .slice(0, relayBound),
    );
    expect(long).toHaveLength(relayBound);
    expect(
      runScript(relay, { result: { code: 'NO_RESULT', message: 'no result' } }),
    ).toBe('Page p0003 failed [NO_RESULT]: no result');
    expect(runScript(relay, { result: null })).toBe(
      'Page p0003 failed [undefined]: undefined',
    );
  });

  test('refuse a trigger payload by the keys it expects', () => {
    expect(
      refusalOf(() =>
        runScript(
          script(payloadRefusal(['claim', 'token', "it's"])),
          undefined,
        ),
      ),
    ).toBe("Invalid trigger payload: expected {claim, token, it's}");
  });
});

describe('Flow descriptions', () => {
  test('follow one layout: what, input, answers, failure, caller', () => {
    expect(
      flowDescription({
        answers: ['ok: true', 'completed', 'domain'],
        caller: 'Data / Process pending',
        does: 'Counts every course and academic year of an enrollments claim',
        failure: { codes: ['ENROLLMENTS_FAILED'] },
        input: ['claim', 'revision'],
      }),
    ).toBe(
      'Counts every course and academic year of an enrollments claim. Input {claim, revision}. Answers {ok: true, completed, domain} or {ok: false, stage, code, message}; failure code ENROLLMENTS_FAILED. Called by "Data / Process pending".',
    );
    expect(
      flowDescription({
        answers: ['page', 'staged'],
        does: 'Matches one planned page of history lines',
        failure: {
          codes: ['MATCH_FAILED', 'INDEX_FAILED'],
          context: ['page'],
        },
      }),
    ).toBe(
      'Matches one planned page of history lines. Answers {page, staged} or {ok: false, page, stage, code, message}; failure codes MATCH_FAILED, INDEX_FAILED.',
    );
  });

  test('state one more fact after what a manual Flow does', () => {
    expect(
      flowDescription({
        does: 'Uploads every declared public file to storage location "s3", serially',
        note: 'Outcome: completed, partial or failed',
      }),
    ).toBe(
      'Uploads every declared public file to storage location "s3", serially. Outcome: completed, partial or failed.',
    );
    expect(
      flowDescription({
        answers: ['ok', 'filename', 'outcome'],
        does: 'Uploads one public file.',
        failure: 'never rejects',
        input: ['claim', 'filename'],
      }),
    ).toBe(
      'Uploads one public file. Input {claim, filename}. Answers {ok, filename, outcome}; never rejects.',
    );
    expect(
      flowDescription({
        answers: ['ok', 'pages'],
        does: 'Plans the pages',
        failure: {},
      }),
    ).toBe(
      'Plans the pages. Answers {ok, pages} or {ok: false, stage, code, message}.',
    );
  });
});

describe('Flow operation names', () => {
  test('name the failure branch steps by stage and code', () => {
    expect(stepName.failClaim('enrollments_run')).toBe(
      'Fail claim: enrollments_run',
    );
    expect(stepName.answerFailure('pairs')).toBe('Answer failure: pairs');
    expect(stepName.raise('PUBLICATION_NOT_PREPARED')).toBe(
      'Throw PUBLICATION_NOT_PREPARED',
    );
  });
});
