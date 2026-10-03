import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import {
  claimDomains,
  domainLabel,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  snapshotFolderId,
  snapshotFolderName,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { claimChoices } from '../src/data-model/operations-vocabularies.js';
import { flowFamilyCodes, insertionOrder } from '../src/flows/flow-template.js';
import { installFlowFamily } from '../src/flows/registry.js';
import {
  installSnapshotFolder,
  snapshotFolder,
} from '../src/flows/snapshot-folder.js';
import {
  confirmationDescription,
  replacementNote,
  snapshotFlowId,
  snapshotImportFlow,
} from '../src/flows/snapshot-import.js';

const flowBody = z.object({ id: z.string(), status: z.string() });
const snapshotFamily = /^6a1d9f0e-2b3c-4d5e-8f70-0000000010\d{2}$/u;

const operationByKey = (key: string) => {
  const found = snapshotImportFlow.operations.find(
    (operation) => operation.key === key,
  );
  if (found === undefined) {
    throw new Error(`no operation ${key}`);
  }
  return found;
};

const next = (key: string, edge: 'reject' | 'resolve') => {
  const target = operationByKey(key)[edge];
  return (
    snapshotImportFlow.operations.find(({ id }) => id === target)?.key ?? null
  );
};

describe('snapshot import Flow template', () => {
  test('checks the confirmation before importing and promoting', () => {
    expect(snapshotImportFlow.id).toBe(snapshotFlowId);
    expect(snapshotImportFlow.accountability).toBe('activity');
    expect(snapshotImportFlow.trigger).toBe('manual');
    expect(snapshotImportFlow.entry).toBe(operationByKey('confirmed').id);
    expect(
      ['confirmed', 'import', 'staged', 'promote'].map((key) => [
        next(key, 'resolve'),
        next(key, 'reject'),
      ]),
    ).toEqual([
      ['import', 'raise_unconfirmed'],
      ['staged', 'import_failed'],
      ['promote', 'raise_not_staged'],
      ['summary', 'promote_failed'],
    ]);
    expect(operationByKey('import')).toMatchObject({
      options: { file: '{{ $trigger.body.file }}' },
      type: 'finki-hub-snapshot-import',
    });
    expect(operationByKey('promote')).toMatchObject({
      options: {
        allow_empty: '{{ $trigger.body.allow_empty }}',
        confirm_replace: '{{ $trigger.body.confirm_replace }}',
        staging_fingerprint: '{{ import.fingerprint }}',
      },
      type: 'finki-hub-snapshot-promote',
    });
    expect(operationByKey('import_failed').options).toEqual({
      code: '{{ import.code }}',
      message: '{{ import.message }}',
      status: '{{ import.status }}',
    });
    expect(snapshotImportFlow.options).toMatchObject({
      async: false,
      collections: ['data_operations'],
      error_on_reject: true,
      requireConfirmation: true,
      requireSelection: false,
    });
    // The dialog title is one question; the facts are the note of the
    // confirmation field.
    expect(confirmationDescription).toBe(
      'Replace the active Moodle snapshot (moodle_users) with the selected CSV?',
    );
    expect(replacementNote).toContain('Directus-only edit');
    expect(replacementNote).toContain('Backup');
    expect(replacementNote).toContain('Never touched');
    expect(replacementNote).toContain(snapshotFolder.name);
    expect(JSON.stringify(snapshotImportFlow.options)).toContain(
      JSON.stringify(replacementNote),
    );
  });

  test('is a tree of deterministic ids that installs in edge order', () => {
    const ids = snapshotImportFlow.operations.map(({ id }) => id);
    const targets = snapshotImportFlow.operations
      .flatMap(({ reject, resolve }) => [reject, resolve])
      .filter((target) => target !== null);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => snapshotFamily.test(id))).toBeTruthy();
    expect(snapshotFamily.test(snapshotFlowId)).toBeTruthy();
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.every((target) => ids.includes(target))).toBeTruthy();
    expect(
      new Set(snapshotImportFlow.operations.map(({ key }) => key)).size,
    ).toBe(ids.length);
    expect(insertionOrder(snapshotImportFlow.operations)).toHaveLength(
      ids.length,
    );
  });

  test('installs once, inactive first, and never touches an existing Flow', async () => {
    const present = new Set<string>();
    const calls: Array<{ body: unknown; method: string; pathname: string }> =
      [];
    const request: DirectusRequest = async (pathname, init) => {
      const method = init?.method ?? 'GET';
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ body, method, pathname });
      if (method === 'GET') {
        const id = new URL(
          pathname,
          'https://fixture.example',
        ).searchParams.get('filter[id][_eq]');
        return id !== null && present.has(id)
          ? [{ id, operation: `${id}-entry` }]
          : [];
      }
      if (pathname === '/flows') {
        present.add(flowBody.parse(body).id);
      }
      return {};
    };

    await expect(
      installFlowFamily(request, flowFamilyCodes.snapshot),
    ).resolves.toMatchObject({
      created: [snapshotImportFlow.name],
      skipped: [],
    });

    const mutations = calls.filter(({ method }) => method !== 'GET');

    expect(
      mutations
        .filter(({ pathname }) => pathname === '/flows')
        .map(({ body }) => flowBody.parse(body).status),
    ).toEqual(['inactive']);
    expect(
      mutations.filter(({ pathname }) => pathname === '/operations'),
    ).toHaveLength(snapshotImportFlow.operations.length);
    expect(mutations.at(-1)?.body).toEqual({
      operation: snapshotImportFlow.entry,
      status: 'active',
    });

    calls.length = 0;

    await expect(
      installFlowFamily(request, flowFamilyCodes.snapshot),
    ).resolves.toMatchObject({
      created: [],
      skipped: [snapshotImportFlow.name],
    });
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  });
});

describe('snapshot folder', () => {
  test('is the one folder the bundle reads snapshots from and writes backups to', () => {
    expect(snapshotFolder).toEqual({
      id: snapshotFolderId,
      name: snapshotFolderName,
    });
  });

  test('is created once and never touched again', async () => {
    const present = new Set<string>();
    const calls: Array<{ body: unknown; method: string; pathname: string }> =
      [];
    const request: DirectusRequest = async (pathname, init) => {
      const method = init?.method ?? 'GET';
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ body, method, pathname });
      if (method === 'GET') {
        return present.has(snapshotFolder.id)
          ? [{ id: snapshotFolder.id }]
          : [];
      }
      present.add(snapshotFolder.id);
      return {};
    };

    await expect(installSnapshotFolder(request)).resolves.toEqual({
      created: [snapshotFolder.name],
      skipped: [],
    });
    expect(calls.filter(({ method }) => method === 'POST')).toEqual([
      {
        body: { ...snapshotFolder, parent: null },
        method: 'POST',
        pathname: '/folders',
      },
    ]);

    calls.length = 0;

    await expect(installSnapshotFolder(request)).resolves.toEqual({
      created: [],
      skipped: [snapshotFolder.name],
    });
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  });
});

describe('snapshot claim domain', () => {
  test('extends the work domains by the snapshot promotion in the bundle and the model', () => {
    expect([...claimDomains]).toEqual([
      'history_index',
      'enrollments',
      'publication',
      'snapshot',
    ]);
    // One declaration: the model builds its choices from the extension's
    // list, each with its declared label.
    expect(claimChoices).toEqual(
      claimDomains.map((value) => ({ label: domainLabel(value), value })),
    );
  });
});
