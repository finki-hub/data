import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

// The explicit restore target of `npm run test:restore`
// (restore.integration.mjs) and the checks that keep the rehearsal on it.
// The target is one disposable name (`finki_restore_<6-32 lowercase letters
// or digits>`) from which the harness derives the exact name of everything
// it creates: a PostgreSQL container, its data volume, an uploads volume
// and the network alias the restored project's Directus reaches the
// database by; each carries the disposable label with that name. A second
// synthetic bucket receives the restored project's publication, so no
// object of the source bucket is ever overwritten, and the private backup
// directory lies outside the repository. Nothing defaults: every name is
// given on the invocation and refused unless it is plainly disposable.

type RestoreTarget = {
  // The network alias of the restore database.
  readonly alias: string;
  // The private directory the backup sets are written under.
  readonly backupRoot: string;
  // The bucket the restored project publishes to.
  readonly bucket: string;
  readonly database: string;
  readonly databaseVolume: string;
  readonly keepBackup: boolean;
  readonly name: string;
  readonly uploadsVolume: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

// The label every restore resource carries, valued with the target name;
// the harness removes a resource only after reading it back.
export const disposableLabel = 'finki.restore.disposable';

const collator = new Intl.Collator('en');
const namePattern = /^finki_restore_[a-z0-9]{6,32}$/u;
const bucketPattern = /^synthetic-restore-[a-z0-9-]*[a-z0-9]$/u;
const keepValues: ReadonlySet<string> = new Set(['', '0', '1']);

const refused = (name: string, rule: string): Error =>
  new Error(`${name} must be ${rule}; refused`);

const required = (
  environment: Environment,
  name: string,
  purpose: string,
): string => {
  const value = environment[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Set ${name} to ${purpose}; the restore harness never assumes one`,
    );
  }
  return value;
};

// Whether `candidate` is `directory` or lies below it.
const within = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

export const restoreTargetFrom = (
  environment: Environment,
  context: { readonly publishBucket: string; readonly repository: string },
): RestoreTarget => {
  const name = required(
    environment,
    'DIRECTUS_RESTORE_TEST_NAME',
    'an explicitly disposable restore name (finki_restore_<6-32 lowercase letters or digits>)',
  );
  if (!namePattern.test(name)) {
    throw refused(
      'DIRECTUS_RESTORE_TEST_NAME',
      'finki_restore_ followed by 6-32 lowercase letters or digits (a disposable restore target)',
    );
  }
  const bucket = required(
    environment,
    'DIRECTUS_RESTORE_TEST_BUCKET',
    'a second synthetic bucket (synthetic-restore-…) for the restored publication',
  );
  if (!bucketPattern.test(bucket)) {
    throw refused('DIRECTUS_RESTORE_TEST_BUCKET', 'a synthetic-restore-… name');
  }
  if (bucket === context.publishBucket) {
    throw refused(
      'DIRECTUS_RESTORE_TEST_BUCKET',
      'another bucket than the source project publishes to, so no source object is overwritten',
    );
  }
  const backupDirectory = required(
    environment,
    'DIRECTUS_RESTORE_BACKUP_DIR',
    'a private directory outside the repository',
  );
  if (!path.isAbsolute(backupDirectory)) {
    throw refused('DIRECTUS_RESTORE_BACKUP_DIR', 'an absolute path');
  }
  const backupRoot = path.resolve(backupDirectory);
  const repository = path.resolve(context.repository);
  if (within(repository, backupRoot) || within(backupRoot, repository)) {
    throw refused(
      'DIRECTUS_RESTORE_BACKUP_DIR',
      'outside the repository (a backup never enters it)',
    );
  }
  const keep = environment['DIRECTUS_RESTORE_KEEP_BACKUP'] ?? '';
  if (!keepValues.has(keep)) {
    throw refused('DIRECTUS_RESTORE_KEEP_BACKUP', 'unset, 0 or 1');
  }
  return {
    alias: `${name.replaceAll('_', '-')}-database`,
    backupRoot,
    bucket,
    database: `${name}_database`,
    databaseVolume: `${name}_database_data`,
    keepBackup: keep === '1',
    name,
    uploadsVolume: `${name}_uploads_data`,
  };
};

// Where Directus keeps the local storage location.
export const uploadsTarget = '/directus/uploads';

// The settings the restore override sets: the database connection and the
// publish bucket. Nothing else of the service may change.
const restoreSettings: ReadonlySet<string> = new Set([
  'DB_DATABASE',
  'DB_HOST',
  'DB_PASSWORD',
  'DB_PORT',
  'DB_USER',
  'STORAGE_PUBLISH_BUCKET',
]);

type RestoreOverride = {
  readonly alias: string;
  readonly bucket: string;
  readonly password: string;
  readonly service: string;
  readonly uploadsVolume: string;
};

const plainValue = /^[\w.-]+$/u;

const quoted = (value: string): string => JSON.stringify(value);

// The private Compose override that points the source project's Directus
// service at the restore database, uploads volume and bucket. Every value
// is a plain token written as a JSON string (valid YAML).
export const overrideYaml = (override: RestoreOverride): string => {
  for (const [key, value] of Object.entries(override)) {
    if (!plainValue.test(value)) {
      throw new Error(`The restore override value ${key} is not plain`);
    }
  }
  return [
    'services:',
    `  ${override.service}:`,
    '    environment:',
    `      DB_DATABASE: ${quoted('directus')}`,
    `      DB_HOST: ${quoted(override.alias)}`,
    `      DB_PASSWORD: ${quoted(override.password)}`,
    `      DB_PORT: ${quoted('5432')}`,
    `      DB_USER: ${quoted('directus')}`,
    `      STORAGE_PUBLISH_BUCKET: ${quoted(override.bucket)}`,
    '    volumes:',
    '      - type: volume',
    '        source: restore_uploads',
    `        target: ${uploadsTarget}`,
    'volumes:',
    '  restore_uploads:',
    '    external: true',
    `    name: ${quoted(override.uploadsVolume)}`,
    '',
  ].join('\n');
};

const serviceSchema = z.looseObject({
  environment: z.record(z.string(), z.string().nullable()).optional(),
  volumes: z
    .array(z.looseObject({ target: z.string(), type: z.string() }))
    .optional(),
});

type ConfigChanges = {
  // Environment names whose value differs (never the values).
  readonly environment: readonly string[];
  // Other service keys that differ.
  readonly other: readonly string[];
  // Mount targets whose mount differs.
  readonly volumes: readonly string[];
};

const changedKeys = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !isDeepStrictEqual(before[key], after[key]))
    .toSorted((left, right) => collator.compare(left, right));

const mountsOf = (
  volumes: ReadonlyArray<{ readonly target: string }> | undefined,
): Record<string, unknown> =>
  Object.fromEntries((volumes ?? []).map((mount) => [mount.target, mount]));

// Every key of a service definition but its environment and mounts.
const restOf = (service: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(service).filter(
      ([key]) => key !== 'environment' && key !== 'volumes',
    ),
  );

// What differs between two resolved definitions of one Compose service
// (`docker compose config --format json`), by name only.
export const configChanges = (
  original: unknown,
  restored: unknown,
): ConfigChanges => {
  const before = serviceSchema.parse(original);
  const after = serviceSchema.parse(restored);
  const { environment: beforeEnvironment, volumes: beforeVolumes } = before;
  const { environment: afterEnvironment, volumes: afterVolumes } = after;
  return {
    environment: changedKeys(beforeEnvironment ?? {}, afterEnvironment ?? {}),
    other: changedKeys(restOf(before), restOf(after)),
    volumes: changedKeys(mountsOf(beforeVolumes), mountsOf(afterVolumes)),
  };
};

// The service that serves the restored project may differ from the one
// the source project runs only in its database connection, its publish
// bucket and its uploads volume. Everything else stays identical, the
// licence key, SECRET (which encrypts the persisted licence) and
// PUBLIC_URL included, so the restored database meets the same licence
// identity in the same single container. Answers the changed names.
export const checkRestoreConfig = (
  original: unknown,
  restored: unknown,
): ConfigChanges => {
  const changes = configChanges(original, restored);
  const unexpected = [
    ...changes.environment.filter((name) => !restoreSettings.has(name)),
    ...changes.volumes.filter((target) => target !== uploadsTarget),
    ...changes.other,
  ];
  if (unexpected.length > 0) {
    throw new Error(
      `The restore override changes more than the database, the publish bucket and the uploads volume (${unexpected.join(', ')}); refused`,
    );
  }
  if (
    !changes.environment.includes('DB_HOST') ||
    !changes.volumes.includes(uploadsTarget)
  ) {
    throw new Error(
      'The restore override does not point the service at the restore database and uploads volume; refused',
    );
  }
  return changes;
};
