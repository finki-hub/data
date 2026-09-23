import { defineOperationApp } from '@directus/extensions-sdk';

import {
  claimTargets,
  coordinationDomains,
  operationId,
  planSources,
} from './coordination/state.js';

const choices = (values: readonly string[]) =>
  values.map((value) => ({ text: value, value }));

const actions = [
  'mark',
  'claim',
  'plan_pages',
  'stage_page',
  'index_page',
  'complete',
  'fail',
  'heartbeat',
  'status',
];

const text = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '--';

export default defineOperationApp({
  description:
    'Coordinates derivation and publication: one exclusive claim per run, candidate counts staged per page, completion only at the claimed source revision.',
  icon: 'sync_lock',
  id: operationId,
  name: 'FINKI Hub data coordination',
  options: [
    {
      field: 'action',
      meta: {
        interface: 'select-dropdown',
        options: { allowNone: false, choices: choices(actions) },
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
        note: 'claim: the domain to run, or next_calculation for the first pending calculation domain in dependency order (history_index, then enrollments; never publication).',
        options: { allowNone: true, choices: choices(claimTargets) },
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
        options: { choices: choices(coordinationDomains) },
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
        note: 'plan_pages: history pages Moodle users (history_index claims), rules pages enrollment rules (enrollments claims while every rule is mapped_entries), enrollments plans both rule families of an enrollments claim (mapped pages, legacy pages, zero pages); planning discards every candidate row staged under the claim.',
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
        note: 'stage_page: [{ "course": 1, "academic_year": 1, "count": 3 }]; index_page: [{ "id": 7, "entries": ["exact history line", "..."] }] for this page only (at most 250 users).',
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
    {
      field: 'files',
      meta: {
        interface: 'input-code',
        note: 'complete (publication): per-file outcomes { "courses": "...", "rooms": "...", "staff": "...", "students": "..." }.',
        options: { language: 'json' },
        width: 'full',
      },
      name: 'Published files',
      type: 'json',
    },
  ],
  overview: (options: Record<string, unknown>) => [
    { label: 'Action', text: text(options['action']) },
    { label: 'Domain', text: text(options['domain'] ?? options['source']) },
  ],
});
