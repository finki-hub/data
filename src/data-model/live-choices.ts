import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { FieldAction, InstallPlan, Refusal } from './plan-types.js';

import { valuesOutside } from './plan-choices.js';

type Realignment = Extract<FieldAction, { readonly kind: 'realign-choices' }>;

const rows = z.array(z.record(z.string(), z.unknown()));
const row = z.record(z.string(), z.unknown());

// How many refused values a refusal names.
const namedValues = 5;

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

const quoted = (values: readonly string[]): string =>
  values
    .slice(0, namedValues)
    .map((value) => JSON.stringify(value.slice(0, 64)))
    .join(', ');

// Every realignment whose field holds a value the declaration no longer
// accepts becomes a refusal: Directus enforces the rule on every later
// write of such a row, so setup changes nothing and names the values.
export const outOfSetRefusals = async (
  request: DirectusRequest,
  plan: InstallPlan,
): Promise<readonly Refusal[]> => {
  const refusals: Refusal[] = [];
  for (const action of plan.fields) {
    if (action.kind !== 'realign-choices') {
      continue;
    }
    const outside = valuesOutside(
      action.field,
      await liveValues(request, action),
    );
    if (outside.length > 0) {
      refusals.push({
        collection: action.collection,
        field: action.field.field,
        reason: `Field ${action.collection}.${action.field.field} holds ${String(outside.length)} value(s) its declared choices no longer accept (${quoted(outside)}); change or clear them, then run setup again. Its choices were not realigned.`,
      });
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
