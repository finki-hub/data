import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

import { countText, listText } from '../text.js';
import { valuesOutside } from './plan-choices.js';
import {
  type FieldAction,
  type InstallPlan,
  type Refusal,
  refusalOf,
} from './plan-types.js';

type Realignment = Extract<FieldAction, { readonly kind: 'realign-choices' }>;

const rows = z.array(z.record(z.string(), z.unknown()));
const row = z.record(z.string(), z.unknown());

// The distinct values the field holds now: one grouped count per value (a
// bounded read however many rows the collection has), or the singleton's
// one value.
const liveValues = async (
  request: DirectusRequest,
  { collection, field, singleton }: Realignment,
): Promise<readonly unknown[]> => {
  const name = encodeURIComponent(field.field);
  if (singleton) {
    return [
      row.parse(await request(`/items/${collection}?fields=${name}`))[
        field.field
      ],
    ];
  }
  return rows
    .parse(
      await request(
        `/items/${collection}?aggregate[count]=*&groupBy[]=${name}&limit=-1`,
      ),
    )
    .map((group) => group[field.field]);
};

// The refused values, quoted and cut to 64 characters, at most five.
const quoted = (values: readonly string[]): string =>
  listText(values.map((value) => JSON.stringify(value.slice(0, 64))));

// Every realignment whose field holds a value the declaration no longer
// accepts becomes a refusal: Directus enforces the rule on every later
// write of such a row, so setup changes nothing and names the values. An
// allow-other field accepts every value, so its values are not read.
export const outOfSetRefusals = async (
  request: DirectusRequest,
  plan: InstallPlan,
): Promise<readonly Refusal[]> => {
  const refusals: Refusal[] = [];
  for (const action of plan.fields) {
    if (action.kind !== 'realign-choices' || action.field.allowOther === true) {
      continue;
    }
    const outside = valuesOutside(
      action.field,
      await liveValues(request, action),
    );
    if (outside.length > 0) {
      refusals.push(
        refusalOf(
          'Field',
          { collection: action.collection, field: action.field.field },
          {
            live: `${countText(outside.length, 'value', 'values')} outside declared choices: ${quoted(outside)}`,
          },
        ),
      );
    }
  }
  return refusals;
};

// The plan with the refused realignments counted as refusals.
export const withRefusals = (
  plan: InstallPlan,
  refusals: readonly Refusal[],
): InstallPlan => ({
  ...plan,
  refusals: [...plan.refusals, ...refusals],
  summary: {
    ...plan.summary,
    fields: {
      ...plan.summary.fields,
      aligned: plan.summary.fields.aligned - refusals.length,
      refused: plan.summary.fields.refused + refusals.length,
    },
  },
});
