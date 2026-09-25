import { z } from 'zod';

// The explicit S3 target of `npm run test:s3`: a disposable S3-compatible
// server on the loopback interface, one synthetic bucket, the Docker
// container that publishes the endpoint's port (the suite injects a
// storage failure into it), and the Directus container that serves the
// fixture target. Anything that could name a production target is refused
// before a request is sent, and the Directus `publish` storage location is
// checked against the S3 container before anything is uploaded
// (checkPublishLocation): the uploads go wherever that location points,
// whatever the variables here say.

export type S3Target = {
  readonly bucket: string;
  readonly container: string;
  // The Directus container whose publish location the suite writes to.
  readonly directusContainer: string;
  // The endpoint's origin, without a trailing slash.
  readonly endpoint: string;
  readonly port: string;
};

const productionPattern = /amazonaws\.com|r2\.cloudflarestorage\.com/iu;
const bucketPattern = /^synthetic-[a-z0-9-]*[a-z0-9]$/u;
const containerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const portLinePattern = /^(?<inner>\d+)\/tcp -> (?<published>\S+)$/u;
const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);

const required = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = environment[name];
  if (value === undefined || value === '') {
    throw new Error(`Set ${name} explicitly for the S3 publication suite`);
  }
  if (productionPattern.test(value)) {
    throw new Error(`${name} names a production S3 or R2 domain; refused`);
  }
  return value;
};

const refused = (name: string, rule: string): Error =>
  new Error(`${name} must be ${rule}; refused`);

const plainOrigin = (url: URL): boolean =>
  url.protocol === 'http:' &&
  url.username === '' &&
  url.password === '' &&
  url.pathname === '/' &&
  url.search === '' &&
  url.hash === '';

const endpointOf = (value: string): { origin: string; port: string } => {
  const name = 'DIRECTUS_S3_TEST_ENDPOINT';
  if (!URL.canParse(value)) {
    throw refused(name, 'an http:// URL');
  }
  const url = new URL(value);
  if (url.protocol !== 'http:') {
    throw refused(name, 'plain http:// (a local server, never https)');
  }
  if (!loopbackHosts.has(url.hostname)) {
    throw refused(name, 'on 127.0.0.1 or [::1]');
  }
  if (url.port === '') {
    throw refused(name, 'given with its port');
  }
  if (!plainOrigin(url)) {
    throw refused(name, 'an origin without credentials, path or query');
  }
  return { origin: url.origin, port: url.port };
};

const containerOf = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const container = required(environment, name);
  if (!containerPattern.test(container)) {
    throw refused(name, 'a Docker container name');
  }
  return container;
};

export const s3TargetFrom = (
  environment: Readonly<Record<string, string | undefined>>,
): S3Target => {
  const { origin, port } = endpointOf(
    required(environment, 'DIRECTUS_S3_TEST_ENDPOINT'),
  );
  const bucket = required(environment, 'DIRECTUS_S3_TEST_BUCKET');
  if (!bucketPattern.test(bucket)) {
    throw refused('DIRECTUS_S3_TEST_BUCKET', 'a synthetic-… bucket name');
  }
  const container = containerOf(environment, 'DIRECTUS_S3_TEST_CONTAINER');
  const directusContainer = containerOf(
    environment,
    'DIRECTUS_S3_TEST_DIRECTUS_CONTAINER',
  );
  if (directusContainer === container) {
    throw refused(
      'DIRECTUS_S3_TEST_DIRECTUS_CONTAINER',
      'the Directus container, not the S3 one',
    );
  }
  return { bucket, container, directusContainer, endpoint: origin, port };
};

// The container port `docker port <container>` shows published on a host
// and port ("9090/tcp -> 127.0.0.1:19090"), or null when none is.
export const containerPortOf = (
  portOutput: string,
  host: string,
  port: string,
): null | string => {
  for (const line of portOutput.split('\n')) {
    const groups = portLinePattern.exec(line.trim())?.groups;
    if (groups?.['published'] === `${host}:${port}`) {
      return groups['inner'] ?? null;
    }
  }
  return null;
};

const networksSchema = z.record(
  z.string(),
  z.object({
    Aliases: z.array(z.string()).nullable().optional(),
    DNSNames: z.array(z.string()).nullable().optional(),
  }),
);

// The names the Directus container can reach another container by (the
// S3 container, or the database): its container name and its aliases on
// each network the two share (both read as `docker inspect --format
// '{{json .NetworkSettings.Networks}}'`). No shared network, no name.
export const hostsOf = (
  container: { readonly name: string; readonly networks: unknown },
  directusNetworks: unknown,
): string[] => {
  const reachable = new Set(
    Object.keys(networksSchema.parse(directusNetworks)),
  );
  const shared = Object.entries(
    networksSchema.parse(container.networks),
  ).filter(([network]) => reachable.has(network));
  if (shared.length === 0) {
    return [];
  }
  return [
    container.name,
    ...shared.flatMap(([, { Aliases, DNSNames }]) => [
      ...(Aliases ?? []),
      ...(DNSNames ?? []),
    ]),
  ];
};

// The Directus settings that decide where the publish location writes.
// None of them is a credential; the suite reads nothing else.
export const publishSettingNames = [
  'STORAGE_LOCATIONS',
  'STORAGE_PUBLISH_DRIVER',
  'STORAGE_PUBLISH_ENDPOINT',
  'STORAGE_PUBLISH_BUCKET',
  'STORAGE_PUBLISH_ROOT',
  'STORAGE_PUBLISH_ENDPOINT_FILE',
  'STORAGE_PUBLISH_BUCKET_FILE',
] as const;

export type PublishSettings = Readonly<
  Record<(typeof publishSettingNames)[number], null | string>
>;

const refusedSetting = (name: string, rule: string): Error =>
  new Error(
    `The Directus container's ${name} must be ${rule} before the suite uploads anything; refused`,
  );

const reachesS3 = (
  endpoint: null | string,
  s3: { readonly hosts: readonly string[]; readonly port: string },
): boolean => {
  if (
    endpoint === null ||
    productionPattern.test(endpoint) ||
    !URL.canParse(endpoint)
  ) {
    return false;
  }
  const url = new URL(endpoint);
  return (
    plainOrigin(url) && s3.hosts.includes(url.hostname) && url.port === s3.port
  );
};

// Where the Directus publish location writes, checked before any upload:
// the S3 driver, an endpoint without TLS on a name of the S3 container at
// the port it serves (never a production domain), the synthetic bucket,
// no root and no value read from a file. A refusal names the setting,
// never its value.
export const checkPublishLocation = (
  settings: PublishSettings,
  s3: {
    readonly bucket: string;
    readonly hosts: readonly string[];
    readonly port: string;
  },
): void => {
  const locations = (settings.STORAGE_LOCATIONS ?? '')
    .split(',')
    .map((location) => location.trim());
  if (!locations.includes('publish')) {
    throw refusedSetting('STORAGE_LOCATIONS', 'a list naming publish');
  }
  if (settings.STORAGE_PUBLISH_DRIVER !== 's3') {
    throw refusedSetting('STORAGE_PUBLISH_DRIVER', 's3');
  }
  for (const name of [
    'STORAGE_PUBLISH_ENDPOINT_FILE',
    'STORAGE_PUBLISH_BUCKET_FILE',
  ] as const) {
    if (settings[name] !== null) {
      throw refusedSetting(name, 'unset');
    }
  }
  if (!reachesS3(settings.STORAGE_PUBLISH_ENDPOINT, s3)) {
    throw refusedSetting(
      'STORAGE_PUBLISH_ENDPOINT',
      'plain http:// on a name of the S3 container, at the port it serves',
    );
  }
  if (settings.STORAGE_PUBLISH_BUCKET !== s3.bucket) {
    throw refusedSetting(
      'STORAGE_PUBLISH_BUCKET',
      'the bucket DIRECTUS_S3_TEST_BUCKET names',
    );
  }
  if (!['', null].includes(settings.STORAGE_PUBLISH_ROOT)) {
    throw refusedSetting('STORAGE_PUBLISH_ROOT', 'unset');
  }
};
