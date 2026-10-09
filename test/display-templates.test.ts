import { describe, expect, test } from 'vitest';

import type { ModelCollectionKey } from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { findCollection } from './data-model-test-helpers.js';
import { resolves } from './presentation-test-helpers.js';

// How Studio names a record in lists and pickers: the collection's display
// template, the template of each relation to it and of each list of it.

const placeholder = /\{\{(?<path>[^{}]*)\}\}/gu;

const pathsOf = (template: string): readonly string[] =>
  template
    .matchAll(placeholder)
    .map((match) => String(match.groups?.['path']).trim())
    .toArray();

const relationTemplate = (collection: string, field: string) => {
  const found = findCollection(collection).fields.find(
    (candidate) => candidate.field === field,
  );
  return found?.kind === 'm2o' ? found.template : null;
};

const aliasTemplate = (collection: ModelCollectionKey, field: string) =>
  aliasesFor(collection).find(({ alias }) => alias.field === field)?.alias
    .template;

type Template = {
  readonly from: string;
  readonly name: string;
  readonly template: string;
};

// The paths of a template that name no field of the model.
const unresolvedPaths = ({ from, name, template }: Template) =>
  pathsOf(template)
    .filter((path) => !resolves(from, path))
    .map((path) => `${name}: ${path}`);

// Every template of the model with the collection its paths start from.
const templates: readonly Template[] = [
  ...dataModelCollections.map(({ collection, displayTemplate }) => ({
    from: collection,
    name: collection,
    template: displayTemplate,
  })),
  ...dataModelCollections.flatMap(({ collection, fields }) =>
    fields.flatMap((field) =>
      field.kind === 'm2o'
        ? [
            {
              from: field.related,
              name: `${collection}.${field.field}`,
              template: field.template,
            },
          ]
        : [],
    ),
  ),
  ...dataModelCollections.flatMap(({ collection }) =>
    aliasesFor(collection).map(({ alias, relation }) => ({
      from: relation.collection,
      name: `${collection}.${alias.field}`,
      template: alias.template,
    })),
  ),
];

describe('display templates', () => {
  test('name an equivalency by the labels of its members, also where it has no course', () => {
    expect(findCollection('course_equivalencies').displayTemplate).toBe(
      '{{members.label}}',
    );
    expect(aliasTemplate('courses', 'equivalencies')).toBe('{{members.label}}');
    expect(relationTemplate('course_equivalency_members', 'equivalency')).toBe(
      '{{members.label}}',
    );
  });

  test('name a teaching row by course, person and role', () => {
    expect(findCollection('teaching_assignments').displayTemplate).toBe(
      '{{course.name}}: {{staff.name}} ({{role}})',
    );
  });

  test('name a room by its name and location', () => {
    expect(findCollection('rooms').displayTemplate).toBe(
      '{{name}} ({{location}})',
    );
  });

  test('name a Discord channel by its channel and semester, also on the course form', () => {
    expect(findCollection('discord_channels').displayTemplate).toBe(
      '{{channel}} (semester {{semester}})',
    );
    expect(relationTemplate('courses', 'discord_channel')).toBe(
      '{{channel}} (semester {{semester}})',
    );
    expect(aliasTemplate('discord_channels', 'courses')).toBe('{{name}}');
  });

  test("name a dean's office term by its year, position and holder", () => {
    expect(findCollection('deans_office').displayTemplate).toBe(
      '{{year}} {{position}}: {{staff.name}}',
    );
    expect(aliasTemplate('staff', 'dean_terms')).toBe('{{year}} {{position}}');
  });

  test('name only fields of the model', () => {
    expect(templates.length).toBeGreaterThan(dataModelCollections.length);
    expect(templates.flatMap(unresolvedPaths)).toEqual([]);
  });
});
