import { containerPortOf } from './s3-target.js';

// Whether the Docker containers a fixture suite restarts or reads belong to
// its isolated target, decided from what Docker reports (the caller runs
// the read-only commands, docker-reads.mjs): the Directus container must
// publish the target's own loopback port, and the database container must
// be the PostgreSQL server that Directus connects to (its DB_HOST is a name
// the database container has on a network the two share). A refusal names
// the container and the rule, never a setting's value.

const refused = (container: string, rule: string): Error =>
  new Error(`${container} ${rule}; refused`);

const defaultPorts: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
};

// The loopback host and port a target URL is served on.
export const servedAt = (base: URL): { host: string; port: string } => ({
  host: base.hostname,
  port: base.port === '' ? (defaultPorts[base.protocol] ?? '') : base.port,
});

// The Directus container publishes the target's port (`docker port`
// output); answers the port it serves inside Docker.
export const checkServesTarget = (
  container: string,
  portOutput: string,
  base: URL,
): string => {
  const { host, port } = servedAt(base);
  const inner = containerPortOf(portOutput, host, port);
  if (inner === null) {
    throw refused(
      container,
      `does not publish ${host}:${port}, so it is not the Directus container of the target`,
    );
  }
  return inner;
};

// The S3 suites name the Directus container twice (the restart container
// and the one whose publish location they check); both must be one.
export const checkSameDirectus = (
  container: string,
  publishContainer: string,
): void => {
  if (container !== publishContainer) {
    throw refused(
      container,
      'is not the container DIRECTUS_S3_TEST_DIRECTUS_CONTAINER names',
    );
  }
};

// The Directus settings that say which database it connects to; neither is
// a credential.
export const databaseSettingNames = ['DB_CLIENT', 'DB_HOST'] as const;

type DatabaseSettings = Readonly<
  Record<(typeof databaseSettingNames)[number], null | string>
>;

// The database container is the PostgreSQL server the target's Directus
// connects to: DB_CLIENT is pg and DB_HOST is one of the names the database
// container has on a network it shares with Directus (`hosts`).
export const checkDatabaseOf = (
  container: string,
  settings: DatabaseSettings,
  hosts: readonly string[],
): void => {
  if (settings.DB_CLIENT !== 'pg') {
    throw refused(
      container,
      'cannot be the database of the target: its Directus does not use PostgreSQL (DB_CLIENT)',
    );
  }
  if (settings.DB_HOST === null || !hosts.includes(settings.DB_HOST)) {
    throw refused(
      container,
      'is not the database the Directus container of the target connects to (DB_HOST)',
    );
  }
};
