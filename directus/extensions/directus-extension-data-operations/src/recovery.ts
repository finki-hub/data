import { defineHook } from '@directus/extensions-sdk';

import { recoverAbandonedClaim } from './coordinate.js';
import { claimStaleAfterMs } from './coordination/state.js';

type LogSink = {
  readonly info: (details: object, message: string) => void;
  readonly warn: (details: object, message: string) => void;
};

// The Directus logger, narrowed to the two calls this hook makes.
const logSink = (candidate: unknown): LogSink | null =>
  typeof candidate === 'object' &&
  candidate !== null &&
  'info' in candidate &&
  typeof candidate.info === 'function' &&
  'warn' in candidate &&
  typeof candidate.warn === 'function'
    ? (candidate as LogSink)
    : null;

// Startup recovery. A claim taken by a process that no longer exists stops
// heartbeating; once it is silent for longer than the documented window it
// is released with its failure details kept and its domain stays pending:
// a calculation interrupted for the first time at its inputs runs again
// at the next claim, anything else waits for an explicit retry. The check runs when the app is up and once more
// after the window has passed, so a restart mid-run resolves itself even
// when nothing calls claim in the meantime; every claim repeats the check.
export default defineHook(({ init }, { database, logger }) => {
  const log = logSink(logger);
  const recover = async (moment: string): Promise<void> => {
    try {
      const result = await recoverAbandonedClaim(database);
      log?.info(
        { moment, ...result },
        result.released
          ? 'Released an abandoned data-operations claim'
          : 'No abandoned data-operations claim',
      );
    } catch (error) {
      log?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          moment,
        },
        'Data-operations recovery skipped (is the data model installed?)',
      );
    }
  };
  init('app.after', () => {
    void recover('startup');
    setTimeout(() => {
      void recover('after-window');
    }, claimStaleAfterMs + 1_000).unref();
  });
});
