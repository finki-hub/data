import { describe, expect, it } from 'vitest';

import {
  checkDatabaseOf,
  checkSameDirectus,
  checkServesTarget,
  servedAt,
} from './container-binding.js';

// The checks that tie a named Docker container to the isolated target,
// over synthetic `docker port` output and settings.

const base = new URL('http://127.0.0.1:18055');
const directus = 'synthetic-directus';
const database = 'synthetic-database';
const directusPorts = '8055/tcp -> 127.0.0.1:18055\n';
const s3Ports = '9090/tcp -> 127.0.0.1:19090\n';

describe('the Directus container of the target', () => {
  it('is the container that publishes the target port', () => {
    expect(checkServesTarget(directus, directusPorts, base)).toBe('8055');
    expect(
      checkServesTarget(
        directus,
        '8055/tcp -> [::1]:18055\n',
        new URL('http://[::1]:18055'),
      ),
    ).toBe('8055');
  });

  it('refuses a container that publishes another port, another host or none', () => {
    for (const output of [
      s3Ports,
      '8055/tcp -> 0.0.0.0:18055\n',
      '8055/tcp -> 127.0.0.1:18056\n',
      '',
    ]) {
      expect(() => checkServesTarget('synthetic-other', output, base)).toThrow(
        'synthetic-other does not publish 127.0.0.1:18055, so it is not the Directus container of the target; refused',
      );
    }
  });

  it('reads the default port of a URL without one', () => {
    expect(servedAt(new URL('http://127.0.0.1/'))).toEqual({
      host: '127.0.0.1',
      port: '80',
    });
  });

  it('must be the one the S3 target names', () => {
    expect(() => {
      checkSameDirectus(directus, directus);
    }).not.toThrow();
    expect(() => {
      checkSameDirectus(directus, database);
    }).toThrow('DIRECTUS_S3_TEST_DIRECTUS_CONTAINER');
  });
});

describe('the database container of the target', () => {
  const hosts = [database, 'database', '4e1cdd7bf274'];

  it('is the PostgreSQL server the Directus DB_HOST names', () => {
    expect(() => {
      checkDatabaseOf(
        database,
        { DB_CLIENT: 'pg', DB_HOST: 'database' },
        hosts,
      );
    }).not.toThrow();
  });

  it('refuses a container DB_HOST does not name, or no shared network', () => {
    for (const [settings, reachable] of [
      [{ DB_CLIENT: 'pg', DB_HOST: 'other-database' }, hosts],
      [{ DB_CLIENT: 'pg', DB_HOST: null }, hosts],
      [{ DB_CLIENT: 'pg', DB_HOST: 'database' }, []],
    ] as const) {
      expect(() => {
        checkDatabaseOf('synthetic-other', settings, reachable);
      }).toThrow(
        'synthetic-other is not the database the Directus container of the target connects to (DB_HOST); refused',
      );
    }
  });

  it('refuses a Directus that does not use PostgreSQL', () => {
    for (const client of ['sqlite3', null]) {
      expect(() => {
        checkDatabaseOf(
          database,
          { DB_CLIENT: client, DB_HOST: 'database' },
          hosts,
        );
      }).toThrow('DB_CLIENT');
    }
  });
});
