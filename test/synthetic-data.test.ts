import { describe, expect, test } from 'vitest';

import { snapshotFields } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { type WorkbookKey, workbookKeys } from '../src/schema.js';
import { workbookSpecs } from '../src/specs/workbook.js';
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
  workbookKeys.flatMap((key) =>
    dataset[key].flatMap((row) =>
      Object.values(row).filter((value) => typeof value === 'string'),
    ),
  );

// The columns of a workbook part: its spec fields. A Moodle user carries
// every scraper field, the ones only the scraper fills included.
const rowFields = (key: WorkbookKey): readonly string[] =>
  key === 'moodle_users'
    ? snapshotFields
    : (workbookSpecs
        .find((spec) => spec.key === key)
        ?.fields.map(({ target }) => target) ?? []);

describe('synthetic fixture', () => {
  test('contains every part of the workbook with ascending unique ids', () => {
    const dataset = makeSyntheticDataset();

    expect(Object.keys(dataset).toSorted(byText)).toEqual(
      [...workbookKeys].toSorted(byText),
    );

    for (const key of workbookKeys) {
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

  test('uses exactly the field keys of every part plus id', () => {
    const dataset = makeSyntheticDataset();

    for (const key of workbookKeys) {
      const expected = ['id', ...rowFields(key)].toSorted(byText);
      const rows = dataset[key];
      for (const row of rows) {
        expect(Object.keys(row).toSorted(byText)).toEqual(expected);
      }
    }
  });

  test('orders course and Moodle columns like their declarations', () => {
    const dataset = makeSyntheticDataset();

    for (const course of dataset.courses) {
      expect(Object.keys(course)).toEqual(['id', ...rowFields('courses')]);
    }
    for (const user of dataset.moodle_users) {
      expect(Object.keys(user)).toEqual(['id', ...rowFields('moodle_users')]);
    }

    expect(rowFields('moodle_users')).toHaveLength(38);
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
