import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { publishFileFlow } from '../src/flows/publish-one-file.js';
import { publishAssetsFlow } from '../src/flows/publish-public-assets.js';
import {
  installFlow,
  runsSince,
} from './relational/automatic-processing-helpers.mjs';
import { json, read, request } from './relational/data-model-helpers.mjs';
import { remove } from './relational/history-index-helpers.mjs';
import {
  checkPublishLocation,
  containerPortOf,
  publishSettingNames,
  s3HostsOf,
} from './s3-target.js';

// The S3 side, the manual trigger, the probe variants and the injected
// storage failure of the publish-flow suite (publish-flow.integration.mjs).
// S3 is read through the explicit loopback endpoint only. The Docker
// commands are reads (`docker port`, `docker inspect` of the networks,
// `printenv` of the named non-secret STORAGE_* settings in the Directus
// container, `ls` in the S3 container) and a chmod of the S3 container's
// bucket folder, after the container is shown to publish the endpoint's
// port.

const runCommand = promisify(execFile);
const keyPattern = /<Key>(?<key>[^<]+)<\/Key>/gu;
const folderPattern = /^\/tmp\/s3mockFileStore\d+\/synthetic-[a-z0-9-]+$/u;
const trailingNewline = /\n$/u;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const s3Request = (s3, path, init = {}) =>
  fetch(`${s3.endpoint}/${s3.bucket}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });

export const bucketStatus = async (s3) => {
  const response = await s3Request(s3, '', { method: 'HEAD' });
  return response.status;
};

// Every key of the bucket (the synthetic bucket holds a handful).
export const listKeys = async (s3) => {
  const response = await s3Request(s3, '?list-type=2&max-keys=1000');
  assert.equal(response.status, 200);
  const text = await response.text();
  return text
    .matchAll(keyPattern)
    .map(({ groups }) => groups?.key ?? '')
    .toArray();
};

// One object as S3 serves it, or null when absent.
export const readObject = async (s3, key) => {
  const response = await s3Request(s3, `/${encodeURIComponent(key)}`);
  if (response.status === 404) {
    await response.text();
    return null;
  }
  assert.equal(response.status, 200, key);
  const body = await response.text();
  return {
    body,
    contentType: response.headers.get('content-type'),
    lastModified: response.headers.get('last-modified'),
    sha256: sha256(body),
  };
};

export const deleteObject = async (s3, key) => {
  const response = await s3Request(s3, `/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  await response.text();
  assert.ok([200, 204].includes(response.status), `${key} ${response.status}`);
};

// The container port a container publishes on a loopback host and port,
// or null.
const publishedPort = async (container, host, port) => {
  const { stdout } = await runCommand('docker', ['port', container]);
  return containerPortOf(stdout, host, port);
};

// The container must publish exactly the endpoint's loopback port before
// anything is run inside it; answers the port it serves inside Docker.
export const verifyContainer = async (s3) => {
  const port = await publishedPort(
    s3.container,
    new URL(s3.endpoint).hostname,
    s3.port,
  );
  assert.ok(port !== null, `${s3.container} does not publish ${s3.endpoint}`);
  return port;
};

const networksOf = async (container) => {
  const { stdout } = await runCommand('docker', [
    'inspect',
    '--format',
    '{{json .NetworkSettings.Networks}}',
    container,
  ]);
  return JSON.parse(stdout);
};

// One setting of a container's environment, or null when it is unset
// (printenv exits 1). Only the non-secret publishSettingNames are read.
const settingOf = async (container, name) => {
  try {
    const { stdout } = await runCommand('docker', [
      'exec',
      container,
      'printenv',
      name,
    ]);
    return stdout.replace(trailingNewline, '');
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
};

// Where the uploads land is decided by the Directus container's publish
// storage location, never by the suite's own variables: before any upload
// the container that serves the fixture target must write through the S3
// driver to the S3 container (by a name it has on a shared network, at the
// port it serves) and the synthetic bucket (checkPublishLocation). Answers
// what was verified, without any credential.
export const verifyPublishLocation = async (target, s3) => {
  const directusPort = await publishedPort(
    s3.directusContainer,
    target.base.hostname,
    target.base.port,
  );
  assert.ok(
    directusPort !== null,
    `${s3.directusContainer} does not serve the fixture target`,
  );
  const port = await verifyContainer(s3);
  const hosts = s3HostsOf(
    { name: s3.container, networks: await networksOf(s3.container) },
    await networksOf(s3.directusContainer),
  );
  const settings = Object.fromEntries(
    await Promise.all(
      publishSettingNames.map(async (name) => [
        name,
        await settingOf(s3.directusContainer, name),
      ]),
    ),
  );
  checkPublishLocation(settings, { bucket: s3.bucket, hosts, port });
  return {
    bucket: settings.STORAGE_PUBLISH_BUCKET,
    endpoint: settings.STORAGE_PUBLISH_ENDPOINT,
  };
};

// A canary written through the publish location must appear in the
// synthetic bucket, read back through the loopback endpoint, and go when
// its file is deleted: proof that the uploads below land there, before any
// declared file is written. Answers the canary's key.
export const proveCanary = async (target, s3) => {
  const name = `synthetic-canary-${randomUUID()}.json`;
  const body = JSON.stringify({ canary: name });
  const form = new FormData();
  form.append('storage', 'publish');
  form.append('filename_download', name);
  form.append('file', new Blob([body], { type: 'application/json' }), name);
  const created = await read(
    await request(target, '/files', {
      body: form,
      method: 'POST',
      token: target.token,
    }),
    200,
  );
  const { filename_disk: key, id } = created.data;
  try {
    const object = await readObject(s3, key);
    assert.equal(
      object?.body,
      body,
      'the publish location does not write to the synthetic bucket; stopped before any declared file',
    );
  } finally {
    await remove(target, `/files/${id}`);
  }
  assert.equal(await readObject(s3, key), null, 'the canary object is gone');
  return key;
};

const bucketFolder = async (s3) => {
  const { stdout } = await runCommand('docker', [
    'exec',
    s3.container,
    'sh',
    '-c',
    `ls -d /tmp/s3mockFileStore*/${s3.bucket}`,
  ]);
  const folder = stdout.trim();
  assert.match(folder, folderPattern);
  return folder;
};

const setWritable = (s3, folder, writable) =>
  runCommand('docker', [
    'exec',
    '-u',
    '0',
    s3.container,
    'chmod',
    writable ? '0755' : '0555',
    folder,
  ]);

// A real storage-level failure: the S3 server cannot persist a new object
// while its bucket folder is read-only, and answers 500. The folder is
// writable again whatever the body does.
export const readOnlyBucket = async (s3) => {
  const folder = await bucketFolder(s3);
  await setWritable(s3, folder, false);
  return async () => {
    await setWritable(s3, folder, true);
  };
};

// A manual Flow posted like Studio's button: the answer, or the refusal.
export const trigger = async (target, flowId, token = target.token) => {
  const response = await request(
    target,
    `/flows/trigger/${flowId}`,
    json('POST', { collection: 'data_operations' }, token),
  );
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

export const errorOf = (body) => ({
  code: body?.errors?.[0]?.extensions?.code ?? null,
  message: body?.errors?.[0]?.message ?? '',
});

// The probe variants: copies of the publish Flows under synthetic ids,
// whose child waits before the files named, so the suite can act between
// two uploads. They claim publication like the real Flow, so while they
// are installed they are part of the publication graph only.
const probeId = (id) => `9e4d826c-5b1a-4c0e-8f2d-0000009f${id.slice(-4)}`;

export const probeChildId = probeId(publishFileFlow.id);
export const probeParentId = probeId(publishAssetsFlow.id);

const remapped = (operation) => ({
  ...operation,
  id: probeId(operation.id),
  options:
    operation.type === 'trigger'
      ? { ...operation.options, flow: probeChildId }
      : operation.options,
  reject: operation.reject === null ? null : probeId(operation.reject),
  resolve: operation.resolve === null ? null : probeId(operation.resolve),
});

const flowBody = (template, id, name) => ({
  accountability: template.accountability,
  description: `Synthetic probe of "${template.name}" (Task 15 publish-flow suite); removed by the suite.`,
  icon: template.icon,
  id,
  name,
  options: template.options,
  trigger: template.trigger,
});

export const installProbe = async (target, waitBefore, waitMs) => {
  const keepClaim = probeId(publishFileFlow.entry);
  const waitId = probeId('15f1');
  const sleepId = probeId('15f2');
  const child = [
    {
      id: waitId,
      key: 'probe_wait',
      name: 'Wait before this file?',
      options: {
        filter: { $trigger: { filename: { _in: [...waitBefore] } } },
      },
      position_x: 1,
      position_y: 1,
      reject: keepClaim,
      resolve: sleepId,
      type: 'condition',
    },
    {
      id: sleepId,
      key: 'probe_sleep',
      name: 'Wait',
      options: { milliseconds: waitMs },
      position_x: 1,
      position_y: 19,
      reject: null,
      resolve: keepClaim,
      type: 'sleep',
    },
    ...publishFileFlow.operations.map((operation) => remapped(operation)),
  ];
  await installFlow(
    target,
    flowBody(publishFileFlow, probeChildId, 'Synthetic probe / One file'),
    child,
  );
  const parent = publishAssetsFlow.operations.map((operation) =>
    remapped(operation),
  );
  const entry = probeId(publishAssetsFlow.entry);
  await installFlow(
    target,
    flowBody(
      publishAssetsFlow,
      probeParentId,
      'Synthetic probe / Public assets (relational)',
    ),
    [
      ...parent.filter(({ id }) => id === entry),
      ...parent.filter(({ id }) => id !== entry),
    ],
  );
};

// Waits until the probe child finished this many runs since a moment (the
// run activity row is written when a run ends).
export const probeRuns = async (target, since, count) => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await runsSince(target, probeChildId, since)) >= count) return;
    await sleep(100);
  }
  assert.fail(`the probe child did not finish ${count} runs`);
};
