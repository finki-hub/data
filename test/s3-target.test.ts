import { describe, expect, test } from 'vitest';

import {
  checkPublishLocation,
  containerPortOf,
  hostsOf,
  type PublishSettings,
  s3TargetFrom,
} from './s3-target.js';

// A plain-http URL of a host (the refusals below must see HTTP as well as
// HTTPS production hosts).
const plain = (rest: string): string => ['http', rest].join('://');

const endpointRefusal = /DIRECTUS_S3_TEST_ENDPOINT|production/u;
const neverHttps =
  /DIRECTUS_S3_TEST_ENDPOINT must be plain http:\/\/ \(a local server, never https\)/u;
const bucketRefusal = /DIRECTUS_S3_TEST_BUCKET|production/u;
const containerRefusal = /DIRECTUS_S3_TEST_CONTAINER|production/u;
const directusRefusal = /DIRECTUS_S3_TEST_DIRECTUS_CONTAINER|production/u;
const settingRefusal = /The Directus container's STORAGE_[A-Z_]+ must be/u;

const valid = {
  DIRECTUS_S3_TEST_BUCKET: 'synthetic-publish-9e4d826c',
  DIRECTUS_S3_TEST_CONTAINER: 'finki_s3_it_9e4d826c',
  DIRECTUS_S3_TEST_DIRECTUS_CONTAINER: 'finki_search_it_9e4d826c-directus-1',
  DIRECTUS_S3_TEST_ENDPOINT: 'http://127.0.0.1:19090',
};

describe('the S3 test target', () => {
  test('accepts an explicit loopback endpoint, a synthetic bucket and a container', () => {
    expect(s3TargetFrom(valid)).toEqual({
      bucket: 'synthetic-publish-9e4d826c',
      container: 'finki_s3_it_9e4d826c',
      directusContainer: 'finki_search_it_9e4d826c-directus-1',
      endpoint: 'http://127.0.0.1:19090',
      port: '19090',
    });
    expect(
      s3TargetFrom({
        ...valid,
        DIRECTUS_S3_TEST_ENDPOINT: 'http://[::1]:9090/',
      }),
    ).toMatchObject({ endpoint: 'http://[::1]:9090', port: '9090' });
  });

  test('refuses https for what it is: never a local server', () => {
    expect(() =>
      s3TargetFrom({
        ...valid,
        DIRECTUS_S3_TEST_ENDPOINT: 'https://127.0.0.1:19090',
      }),
    ).toThrow(neverHttps);
  });

  test('refuses a missing variable', () => {
    for (const name of Object.keys(valid)) {
      expect(() => s3TargetFrom({ ...valid, [name]: undefined })).toThrow(name);
      expect(() => s3TargetFrom({ ...valid, [name]: '' })).toThrow(name);
    }
  });

  test('refuses a production domain or bucket, https, and any host that is not a loopback literal', () => {
    for (const endpoint of [
      'https://127.0.0.1:19090',
      'https://abc123.r2.cloudflarestorage.com',
      plain('abc123.r2.cloudflarestorage.com'),
      'https://s3.eu-central-1.amazonaws.com',
      plain('bucket.s3.amazonaws.com:80'),
      plain('localhost:19090'),
      plain('127.0.0.2:19090'),
      plain('0.0.0.0:19090'),
      plain('10.0.0.5:9090'),
      'http://127.0.0.1',
      'http://127.0.0.1:19090/synthetic-publish-9e4d826c',
      'http://user:secret@127.0.0.1:19090',
      'http://127.0.0.1:19090/?x=amazonaws.com',
      'not a url',
    ]) {
      expect(() =>
        s3TargetFrom({ ...valid, DIRECTUS_S3_TEST_ENDPOINT: endpoint }),
      ).toThrow(endpointRefusal);
    }
    for (const bucket of [
      'finki-hub-public',
      'synthetic_publish',
      'Synthetic-publish',
      'synthetic-',
      'synthetic-publish.r2.cloudflarestorage.com',
      'synthetic-amazonaws.com',
    ]) {
      expect(() =>
        s3TargetFrom({ ...valid, DIRECTUS_S3_TEST_BUCKET: bucket }),
      ).toThrow(bucketRefusal);
    }
    for (const container of [
      'finki; rm -rf /',
      '-finki',
      'finki s3',
      'x'.repeat(129),
      'mirror.amazonaws.com',
    ]) {
      expect(() =>
        s3TargetFrom({ ...valid, DIRECTUS_S3_TEST_CONTAINER: container }),
      ).toThrow(containerRefusal);
      expect(() =>
        s3TargetFrom({
          ...valid,
          DIRECTUS_S3_TEST_DIRECTUS_CONTAINER: container,
        }),
      ).toThrow(directusRefusal);
    }

    expect(() =>
      s3TargetFrom({
        ...valid,
        DIRECTUS_S3_TEST_DIRECTUS_CONTAINER: valid.DIRECTUS_S3_TEST_CONTAINER,
      }),
    ).toThrow(directusRefusal);
  });
});

describe('the Docker readings', () => {
  test('find the container port published on a loopback host and port', () => {
    const output = [
      '9090/tcp -> 127.0.0.1:19090',
      '9191/tcp -> 0.0.0.0:19191',
      '9292/tcp -> [::1]:19292',
      '',
    ].join('\n');

    expect(containerPortOf(output, '127.0.0.1', '19090')).toBe('9090');
    expect(containerPortOf(output, '[::1]', '19292')).toBe('9292');
    expect(containerPortOf(output, '127.0.0.1', '19191')).toBeNull();
    expect(containerPortOf('', '127.0.0.1', '19090')).toBeNull();
  });

  test('name the S3 container by its name and aliases on shared networks only', () => {
    const s3 = {
      name: 'finki_s3_it_9e4d826c',
      networks: {
        elsewhere: { Aliases: ['decoy'], DNSNames: null },
        fixture: {
          Aliases: ['s3'],
          DNSNames: ['finki_s3_it_9e4d826c', 's3', '5e27ac0a0da5'],
        },
      },
    };

    expect(hostsOf(s3, { fixture: {} })).toEqual([
      'finki_s3_it_9e4d826c',
      's3',
      'finki_s3_it_9e4d826c',
      's3',
      '5e27ac0a0da5',
    ]);
    expect(hostsOf(s3, { other: {} })).toEqual([]);
    expect(() => hostsOf({ ...s3, networks: 'x' }, {})).toThrow();
  });
});

describe('the Directus publish location', () => {
  const s3 = {
    bucket: 'synthetic-publish-9e4d826c',
    hosts: ['finki_s3_it_9e4d826c', 's3'],
    port: '9090',
  };
  const fixture: PublishSettings = {
    STORAGE_LOCATIONS: 'local,publish',
    STORAGE_PUBLISH_BUCKET: 'synthetic-publish-9e4d826c',
    STORAGE_PUBLISH_BUCKET_FILE: null,
    STORAGE_PUBLISH_DRIVER: 's3',
    STORAGE_PUBLISH_ENDPOINT: plain('s3:9090'),
    STORAGE_PUBLISH_ENDPOINT_FILE: null,
    STORAGE_PUBLISH_ROOT: null,
  };
  const account = 'abc123';

  test('is accepted when it writes to the S3 container’s synthetic bucket', () => {
    expect(() => {
      checkPublishLocation(fixture, s3);
    }).not.toThrow();
    expect(() => {
      checkPublishLocation(
        {
          ...fixture,
          STORAGE_LOCATIONS: 'local, publish',
          STORAGE_PUBLISH_ENDPOINT: plain('finki_s3_it_9e4d826c:9090/'),
          STORAGE_PUBLISH_ROOT: '',
        },
        s3,
      );
    }).not.toThrow();
  });

  test('is refused before any upload when it could write anywhere else, naming the setting but never its value', () => {
    const cases: ReadonlyArray<Partial<PublishSettings>> = [
      { STORAGE_LOCATIONS: 'local' },
      { STORAGE_LOCATIONS: null },
      { STORAGE_PUBLISH_DRIVER: 'local' },
      { STORAGE_PUBLISH_ENDPOINT: null },
      {
        STORAGE_PUBLISH_ENDPOINT: `https://${account}.r2.cloudflarestorage.com`,
      },
      {
        STORAGE_PUBLISH_ENDPOINT: plain(`${account}.r2.cloudflarestorage.com`),
      },
      { STORAGE_PUBLISH_ENDPOINT: plain('s3.amazonaws.com:9090') },
      { STORAGE_PUBLISH_ENDPOINT: 'https://s3:9090' },
      { STORAGE_PUBLISH_ENDPOINT: plain('minio:9090') },
      { STORAGE_PUBLISH_ENDPOINT: 'http://127.0.0.1:19090' },
      { STORAGE_PUBLISH_ENDPOINT: plain('s3:9000') },
      { STORAGE_PUBLISH_ENDPOINT: plain('s3') },
      { STORAGE_PUBLISH_ENDPOINT: plain('s3:9090/other-bucket') },
      { STORAGE_PUBLISH_ENDPOINT: plain('key:secret@s3:9090') },
      { STORAGE_PUBLISH_BUCKET: `${account}-public` },
      { STORAGE_PUBLISH_BUCKET: null },
      { STORAGE_PUBLISH_ROOT: 'nested' },
      { STORAGE_PUBLISH_ENDPOINT_FILE: '/run/secrets/endpoint' },
      { STORAGE_PUBLISH_BUCKET_FILE: '/run/secrets/bucket' },
    ];

    for (const change of cases) {
      const attempt = () => {
        checkPublishLocation({ ...fixture, ...change }, s3);
      };

      expect(attempt).toThrow(settingRefusal);
      expect(attempt).not.toThrow(account);
    }

    expect(() => {
      checkPublishLocation(fixture, { ...s3, hosts: [] });
    }).toThrow(settingRefusal);
  });
});
