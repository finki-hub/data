import { defineOperationApp } from '@directus/extensions-sdk';

import {
  claimTargets,
  coordinationDomains,
  coordinatorActionNames,
  domainLabel,
  isDomain,
  nextCalculation,
} from './coordination/domains.js';
import {
  maxRowsPerPage,
  operationId,
  pageSize,
  type PageSource,
  pageSourceDomains,
  planSources,
} from './coordination/state.js';

const choices = (values: readonly string[]) =>
  values.map((value) => ({ text: value, value }));

// A domain choice shows its declared label.
const domainChoices = (values: readonly string[]) =>
  values.map((value) => ({
    text: isDomain(value) ? domainLabel(value) : value,
    value,
  }));

// A plan source with the claim domain it is planned under.
const sourceText = (source: PageSource): string =>
  `${source} (${pageSourceDomains[source]} claim)`;

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

export default defineOperationApp({
  description:
    'Coordinates derivation and publication: one exclusive claim per run, candidates staged per page, completion only at the claimed source revision.',
  icon: 'sync_lock',
  id: operationId,
  name: 'FINKI Hub data coordination',
  options: [
    {
      field: 'action',
      meta: {
        interface: 'select-dropdown',
        options: { allowNone: false, choices: choices(coordinatorActionNames) },
        required: true,
        width: 'half',
      },
      name: 'Action',
      type: 'string',
    },
    {
      field: 'domain',
      meta: {
        interface: 'select-dropdown',
        note: `claim: the domain to run, or ${nextCalculation} for the first pending calculation domain in dependency order (never publication).`,
        options: { allowNone: true, choices: domainChoices(claimTargets) },
        width: 'half',
      },
      name: 'Domain',
      type: 'string',
    },
    {
      field: 'domains',
      meta: {
        interface: 'select-multiple-checkbox',
        note: 'mark: the domains to mark pending.',
        options: { choices: domainChoices(coordinationDomains) },
        width: 'half',
      },
      name: 'Domains',
      type: 'json',
    },
    {
      field: 'retry',
      meta: {
        interface: 'boolean',
        note: 'claim: also retry a domain whose last run failed at this same revision.',
        width: 'half',
      },
      name: 'Explicit retry',
      type: 'boolean',
    },
    {
      field: 'token',
      meta: {
        interface: 'input',
        note: 'The claim token, for example {{ claim.token }}.',
        width: 'half',
      },
      name: 'Claim token',
      type: 'string',
    },
    {
      field: 'source',
      meta: {
        interface: 'select-dropdown',
        note: `plan_pages: ${planSources.map(sourceText).join(', ')}.`,
        options: { allowNone: true, choices: choices(planSources) },
        width: 'half',
      },
      name: 'Page source',
      type: 'string',
    },
    {
      field: 'page',
      meta: {
        interface: 'input',
        note: 'stage_page, index_page: the page token from plan_pages, for example {{ $trigger.token }}.',
        width: 'half',
      },
      name: 'Page token',
      type: 'string',
    },
    {
      field: 'rows',
      meta: {
        interface: 'input-code',
        note: `stage_page: [{ "entry": 7, "pattern_mapping": 3, "year_label": "2025/2026" }] (at most ${String(maxRowsPerPage)} matches); index_page: [{ "id": 7, "entries": ["exact history line", "..."] }] for this page only (at most ${String(pageSize)} users).`,
        options: { language: 'json' },
        width: 'full',
      },
      name: 'Page rows',
      type: 'json',
    },
    {
      field: 'code',
      meta: {
        interface: 'input',
        note: 'fail: a short failure code kept in the status.',
        width: 'half',
      },
      name: 'Failure code',
      type: 'string',
    },
    {
      field: 'message',
      meta: {
        interface: 'input',
        note: 'fail: why, kept in the status beside the code (ids and counts only; cut to 600 characters).',
        width: 'full',
      },
      name: 'Failure message',
      type: 'string',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    { label: 'Action', text: text(options['action']) },
    { label: 'Domain', text: text(options['domain']) },
    { label: 'Source', text: text(options['source']) },
  ],
});
