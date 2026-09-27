import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// A test-owned database session that makes the next enrollments install
// lose a deadlock, for the fixture proof that the coordinator runs the
// install again in place (conflict-retry.ts). It is the only session of
// the suites that is not read-only, and it writes nothing: it holds
// course_enrollments in SHARE mode (every read passes, the install's
// DELETE waits), waits until a backend that holds the coordination
// singleton waits for that table, then asks for the singleton itself and
// rolls back. The install waited first, so its own deadlock check (the
// server's deadlock_timeout, 1 s) finds the cycle and aborts it; this
// session's check is pushed out to a minute, so it is never the one
// aborted. Without an install within two minutes, or a lock within 30 s,
// it fails and rolls back.

const runCommand = promisify(execFile);
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;

const installDeadlockSql = `BEGIN;
SET LOCAL deadlock_timeout = '60s';
SET LOCAL lock_timeout = '30s';
LOCK TABLE "course_enrollments" IN SHARE MODE;
DO $$
BEGIN
  FOR attempt IN 1..2400 LOOP
    IF EXISTS (
      SELECT 1 FROM pg_locks waiting
      JOIN pg_locks holding ON holding.pid = waiting.pid
      WHERE NOT waiting.granted AND waiting.relation = 'course_enrollments'::regclass
        AND holding.granted AND holding.relation = 'data_operations'::regclass
    ) THEN
      RETURN;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RAISE EXCEPTION 'no install waited for course_enrollments';
END
$$;
SELECT "id" FROM "data_operations" FOR UPDATE;
ROLLBACK;`;

// Resolves once the install lost the deadlock and this session rolled
// back; start it before the run reaches its install.
export const forcesInstallDeadlock = async (container) => {
  assert.match(container ?? '', containerPattern);
  await runCommand('docker', [
    'exec',
    container,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'directus',
    '-d',
    'directus',
    '-At',
    '-c',
    installDeadlockSql,
  ]);
};
