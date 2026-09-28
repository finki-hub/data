import { describe, expect, test } from 'vitest';

import { collectionSpecs } from '../src/model.js';
import { type CollectionKey, collectionKeys } from '../src/schema.js';
import {
  makeSyntheticDataset,
  privateSentinels,
  sentinelPrivateId,
  sentinelPrivateMail,
  sentinelPrivateSourceGroup,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';

const byText = (left: string, right: string): number =>
  left.localeCompare(right);

const byNumber = (left: number, right: number): number => left - right;

const exampleDomain = /^[a-z0-9.-]+\.example$/u;

const stringValues = (dataset: SyntheticDataset): readonly string[] =>
  collectionKeys.flatMap((key) =>
    dataset[key].flatMap((row) =>
      Object.values(row).filter((value) => typeof value === 'string'),
    ),
  );

// The columns of a collection the workbook fills: its spec fields but the
// derived ones.
const workbookTargets = (key: CollectionKey): readonly string[] =>
  collectionSpecs
    .find((spec) => spec.key === key)
    ?.fields.filter(({ derived }) => derived !== true)
    .map(({ target }) => target) ?? [];

describe('synthetic fixture', () => {
  test('contains every migration collection with ascending unique ids', () => {
    const dataset = makeSyntheticDataset();

    expect(Object.keys(dataset).toSorted(byText)).toEqual(
      [...collectionKeys].toSorted(byText),
    );

    for (const key of collectionKeys) {
      const ids = dataset[key].map((row) => row.id);

      expect(ids).not.toHaveLength(0);
      expect(ids).toEqual(ids.toSorted(byNumber));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('is deterministic and hands out fresh objects', () => {
    const first = makeSyntheticDataset();
    const second = makeSyntheticDataset();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.courses).not.toBe(first.courses);
    expect(second.courses[0]).not.toBe(first.courses[0]);
  });

  test('uses exactly the workbook field keys of the spec plus id in every collection', () => {
    const dataset = makeSyntheticDataset();

    for (const key of collectionKeys) {
      const expected = ['id', ...workbookTargets(key)].toSorted(byText);
      const rows = dataset[key];
      for (const row of rows) {
        expect(Object.keys(row).toSorted(byText)).toEqual(expected);
      }
    }
  });

  test('orders course and Moodle columns like the specs', () => {
    const dataset = makeSyntheticDataset();

    for (const course of dataset.courses) {
      expect(Object.keys(course)).toEqual([
        'id',
        ...workbookTargets('courses'),
      ]);
    }
    for (const user of dataset.moodle_users) {
      expect(Object.keys(user)).toEqual([
        'id',
        ...workbookTargets('moodle_users'),
      ]);
    }

    expect(workbookTargets('moodle_users')).toHaveLength(38);
  });

  test('uses .example addresses only', () => {
    const addresses = stringValues(makeSyntheticDataset()).filter((value) =>
      value.includes('@'),
    );

    expect(addresses).not.toHaveLength(0);

    for (const address of addresses) {
      expect(address.slice(address.lastIndexOf('@') + 1)).toMatch(
        exampleDomain,
      );
    }
  });

  test('keeps private sentinels out of the public collections', () => {
    const dataset = makeSyntheticDataset();
    const publicRows = JSON.stringify([
      dataset.courses,
      dataset.rooms,
      dataset.staff,
      dataset.students.map((row) => ({ ...row, source_group: null })),
    ]);

    for (const sentinel of privateSentinels) {
      expect(publicRows).not.toContain(sentinel);
    }

    expect(JSON.stringify(dataset.students)).toContain(
      sentinelPrivateSourceGroup,
    );
    expect(JSON.stringify(dataset.moodle_users)).toContain(sentinelPrivateMail);
    expect(JSON.stringify(dataset.moodle_users)).toContain(sentinelPrivateId);
  });
});
