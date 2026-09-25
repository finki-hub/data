import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  backupFiles,
  type BackupManifest,
  backupProblems,
  checksumsText,
  type Measured,
  parseChecksums,
} from './restore-backup-set.js';
import {
  checkRestoreConfig,
  configChanges,
  overrideYaml,
  restoreTargetFrom,
} from './restore-target.js';

// The restore target of `npm run test:restore`, its Compose override and
// the checks on the backup set, over synthetic names and values only.

const repository = '/synthetic/checkout';
const publishBucket = 'synthetic-publish-fixture';
const restoreBucket = 'synthetic-restore-a1b2c3';
const identityPattern = /LICENSE|PUBLIC_URL|SECRET/u;
// Generated per run: no credential-shaped literal in the source.
const restorePassword = randomBytes(12).toString('hex');
const originalPassword = randomBytes(12).toString('hex');
const context = { publishBucket, repository };
const environment = {
  DIRECTUS_RESTORE_BACKUP_DIR: '/synthetic/private/restore',
  DIRECTUS_RESTORE_TEST_BUCKET: restoreBucket,
  DIRECTUS_RESTORE_TEST_NAME: 'finki_restore_a1b2c3',
};

describe('the restore target', () => {
  it('derives every resource name from one disposable name', () => {
    expect(restoreTargetFrom(environment, context)).toEqual({
      alias: 'finki-restore-a1b2c3-database',
      backupRoot: '/synthetic/private/restore',
      bucket: restoreBucket,
      database: 'finki_restore_a1b2c3_database',
      databaseVolume: 'finki_restore_a1b2c3_database_data',
      keepBackup: false,
      name: 'finki_restore_a1b2c3',
      uploadsVolume: 'finki_restore_a1b2c3_uploads_data',
    });
    expect(
      restoreTargetFrom(
        { ...environment, DIRECTUS_RESTORE_KEEP_BACKUP: '1' },
        context,
      ).keepBackup,
    ).toBeTruthy();
  });

  it('never assumes a name, a bucket or a backup directory', () => {
    for (const name of Object.keys(environment)) {
      expect(() =>
        restoreTargetFrom({ ...environment, [name]: '' }, context),
      ).toThrow(`Set ${name} to`);
    }
  });

  it('refuses a name that is not plainly disposable', () => {
    for (const name of [
      'finki_search_it_9e4d826c',
      'finki-hub-data-migration',
      'finki_restore_',
      'finki_restore_ABCDEF',
      'finki_restore_abc',
      'finki_restore_abcdef-database',
    ]) {
      expect(() =>
        restoreTargetFrom(
          { ...environment, DIRECTUS_RESTORE_TEST_NAME: name },
          context,
        ),
      ).toThrow('DIRECTUS_RESTORE_TEST_NAME must be finki_restore_');
    }
  });

  it('refuses the source bucket and any bucket that is not a synthetic restore bucket', () => {
    expect(() =>
      restoreTargetFrom(
        { ...environment, DIRECTUS_RESTORE_TEST_BUCKET: publishBucket },
        { ...context, publishBucket: restoreBucket },
      ),
    ).toThrow('DIRECTUS_RESTORE_TEST_BUCKET must be a synthetic-restore-');
    expect(() =>
      restoreTargetFrom(environment, {
        ...context,
        publishBucket: restoreBucket,
      }),
    ).toThrow('another bucket than the source project publishes to');
  });

  it('keeps the backups out of the repository', () => {
    for (const directory of [
      'relative/restore',
      '/synthetic/checkout/backups',
      '/synthetic/checkout',
      '/synthetic',
    ]) {
      expect(() =>
        restoreTargetFrom(
          { ...environment, DIRECTUS_RESTORE_BACKUP_DIR: directory },
          context,
        ),
      ).toThrow('DIRECTUS_RESTORE_BACKUP_DIR must be');
    }
  });

  it('reads the keep flag only as unset, 0 or 1', () => {
    expect(() =>
      restoreTargetFrom(
        { ...environment, DIRECTUS_RESTORE_KEEP_BACKUP: 'yes' },
        context,
      ),
    ).toThrow('DIRECTUS_RESTORE_KEEP_BACKUP must be unset, 0 or 1');
  });
});

const override = {
  alias: 'finki-restore-a1b2c3-database',
  bucket: restoreBucket,
  password: restorePassword,
  service: 'directus',
  uploadsVolume: 'finki_restore_a1b2c3_uploads_data',
};

const service = {
  environment: {
    DB_HOST: 'database',
    DB_PASSWORD: originalPassword,
    LICENSE_KEY: 'synthetic-key',
    PUBLIC_URL: 'http://127.0.0.1:18055',
    SECRET: 'synthetic-secret',
    STORAGE_PUBLISH_BUCKET: publishBucket,
  },
  image: 'synthetic-image:1',
  ports: [{ published: '18055', target: 8_055 }],
  volumes: [
    { source: 'uploads_data', target: '/directus/uploads', type: 'volume' },
    {
      source: '/synthetic/extensions',
      target: '/directus/extensions',
      type: 'bind',
    },
  ],
};

const restored = {
  ...service,
  environment: {
    ...service.environment,
    DB_HOST: override.alias,
    DB_PASSWORD: override.password,
    STORAGE_PUBLISH_BUCKET: override.bucket,
  },
  volumes: [
    {
      source: override.uploadsVolume,
      target: '/directus/uploads',
      type: 'volume',
    },
    service.volumes[1],
  ],
};

describe('the restore override', () => {
  it('points only the database, the bucket and the uploads volume elsewhere', () => {
    const yaml = overrideYaml(override);

    expect(yaml).toContain('      DB_HOST: "finki-restore-a1b2c3-database"');
    expect(yaml).toContain(`      STORAGE_PUBLISH_BUCKET: "${restoreBucket}"`);
    expect(yaml).toContain('        target: /directus/uploads');
    expect(yaml).toContain('    name: "finki_restore_a1b2c3_uploads_data"');
    expect(yaml).not.toMatch(identityPattern);
  });

  it('refuses a value that is not a plain token', () => {
    expect(() => overrideYaml({ ...override, password: 'two words' })).toThrow(
      'The restore override value password is not plain',
    );
    expect(() => overrideYaml({ ...override, bucket: 'a"b' })).toThrow(
      'value bucket',
    );
  });

  it('names what changed, never a value', () => {
    expect(configChanges(service, restored)).toEqual({
      environment: ['DB_HOST', 'DB_PASSWORD', 'STORAGE_PUBLISH_BUCKET'],
      other: [],
      volumes: ['/directus/uploads'],
    });
    expect(checkRestoreConfig(service, restored).environment).toHaveLength(3);
  });

  it('refuses a changed licence key, secret, public URL or any other setting', () => {
    for (const name of ['LICENSE_KEY', 'SECRET', 'PUBLIC_URL', 'TELEMETRY']) {
      const changed = {
        ...restored,
        environment: { ...restored.environment, [name]: 'synthetic-other' },
      };

      expect(() => checkRestoreConfig(service, changed)).toThrow(
        `changes more than the database, the publish bucket and the uploads volume (${name})`,
      );
    }
  });

  it('refuses another mount, image or port', () => {
    expect(() =>
      checkRestoreConfig(service, {
        ...restored,
        image: 'synthetic-image:2',
        volumes: [restored.volumes[0]],
      }),
    ).toThrow('(/directus/extensions, image)');
    expect(() =>
      checkRestoreConfig(service, { ...restored, ports: [] }),
    ).toThrow('(ports)');
  });

  it('refuses an override that leaves the database or the uploads in place', () => {
    expect(() =>
      checkRestoreConfig(service, { ...restored, volumes: service.volumes }),
    ).toThrow('does not point the service at the restore database');
    expect(() =>
      checkRestoreConfig(service, {
        ...restored,
        environment: { ...restored.environment, DB_HOST: 'database' },
      }),
    ).toThrow('does not point the service at the restore database');
  });
});

const sha = (digit: string): string => digit.repeat(64);

const manifest: BackupManifest = {
  artifacts: [
    {
      bytes: 2_048,
      file: backupFiles.database,
      kind: 'database',
      sha256: sha('a'),
    },
    {
      bytes: 512,
      file: backupFiles.uploads,
      kind: 'uploads',
      sha256: sha('b'),
    },
  ],
  createdAt: '2026-09-25T12:00:00.000Z',
  source: {
    database: 'synthetic-database',
    directus: 'synthetic-directus',
    project: 'synthetic-project',
  },
  version: 'restore-backup-1',
};

const measured = new Map<string, Measured>([
  [backupFiles.database, { bytes: 2_048, sha256: sha('a') }],
  [backupFiles.uploads, { bytes: 512, sha256: sha('b') }],
]);

describe('a backup set', () => {
  it('passes when every artifact equals both records', () => {
    const checksums = parseChecksums(checksumsText(manifest.artifacts));

    expect(checksumsText(manifest.artifacts)).toBe(
      `${sha('a')}  directus.dump\n${sha('b')}  uploads.tar\n`,
    );
    expect(backupProblems(manifest, checksums, measured)).toEqual([]);
  });

  it('refuses a truncated dump and an altered one', () => {
    const checksums = parseChecksums(checksumsText(manifest.artifacts));

    expect(
      backupProblems(
        manifest,
        checksums,
        new Map([
          ...measured,
          [backupFiles.database, { bytes: 1_024, sha256: sha('c') }],
        ]),
      ),
    ).toEqual([
      'directus.dump holds 1024 bytes, the manifest records 2048',
      'directus.dump does not match its SHA-256 checksum',
    ]);
    expect(
      backupProblems(
        manifest,
        checksums,
        new Map([
          ...measured,
          [backupFiles.database, { bytes: 2_048, sha256: sha('c') }],
        ]),
      ),
    ).toEqual(['directus.dump does not match its SHA-256 checksum']);
  });

  it('refuses a missing artifact, disagreeing records and extra checksums', () => {
    const checksums = new Map([
      ['extra.bin', sha('e')],
      [backupFiles.database, sha('d')],
      [backupFiles.uploads, sha('b')],
    ]);

    expect(
      backupProblems(
        manifest,
        checksums,
        new Map([[backupFiles.database, { bytes: 2_048, sha256: sha('a') }]]),
      ),
    ).toEqual([
      'directus.dump: SHA256SUMS and the manifest disagree',
      'uploads.tar is missing',
      'SHA256SUMS lists extra.bin, which the manifest does not',
    ]);
  });

  it('refuses a manifest without exactly one dump and one archive', () => {
    const [database] = manifest.artifacts;
    const lone = {
      ...manifest,
      artifacts: database === undefined ? [] : [database],
    };

    expect(
      backupProblems(
        lone,
        parseChecksums(checksumsText(lone.artifacts)),
        measured,
      ),
    ).toEqual([
      'the manifest must name exactly one database dump and one uploads archive',
    ]);
  });

  it('refuses a manifest that keeps an artifact under another name than the restore reads', () => {
    const [database, uploads] = manifest.artifacts;
    const swapped: BackupManifest = {
      ...manifest,
      artifacts:
        database === undefined || uploads === undefined
          ? []
          : [
              { ...database, file: backupFiles.uploads },
              { ...uploads, file: backupFiles.database },
            ],
    };
    const renamed: BackupManifest = {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) =>
        artifact.kind === 'database'
          ? { ...artifact, file: 'other.dump' }
          : artifact,
      ),
    };

    expect(
      backupProblems(
        swapped,
        parseChecksums(checksumsText(swapped.artifacts)),
        new Map<string, Measured>([
          [backupFiles.database, { bytes: 512, sha256: sha('b') }],
          [backupFiles.uploads, { bytes: 2_048, sha256: sha('a') }],
        ]),
      ),
    ).toEqual([
      'the manifest names uploads.tar as the database artifact, but the restore reads directus.dump',
      'the manifest names directus.dump as the uploads artifact, but the restore reads uploads.tar',
    ]);
    expect(
      backupProblems(
        renamed,
        parseChecksums(checksumsText(renamed.artifacts)),
        new Map<string, Measured>([
          ...measured,
          ['other.dump', { bytes: 2_048, sha256: sha('a') }],
        ]),
      ),
    ).toEqual([
      'the manifest names other.dump as the database artifact, but the restore reads directus.dump',
    ]);
  });

  it('refuses a malformed or repeated checksum line', () => {
    expect(() => parseChecksums(`${sha('a')} directus.dump\n`)).toThrow(
      'SHA256SUMS holds a malformed line; refused',
    );
    expect(() => parseChecksums('not a checksum\n')).toThrow('malformed');
    expect(() =>
      parseChecksums(
        `${sha('a')}  directus.dump\n${sha('b')}  directus.dump\n`,
      ),
    ).toThrow('SHA256SUMS lists directus.dump twice; refused');
  });
});
