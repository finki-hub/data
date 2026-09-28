// The vocabularies of the coordinator, each declared once and imported by
// every consumer: the status, the options, the failures and decisions, the
// Studio operation form, the Mark pending choices, the scheduler's routes,
// the fingerprint partition and the data model. This module imports
// nothing and uses no zod, so the Studio app bundle can read it.

// What a domain's runs produce: a calculation writes derived rows
// (scheduled, in dependency order), a publication uploads the public files
// (manual only). The kind decides which Flow-graph fingerprint a domain
// runs under.
export const domainKinds = ['calculation', 'publication'] as const;

export type DomainKind = (typeof domainKinds)[number];

// The work domains in dependency order (the history index feeds the
// enrollment counts, and publication reads everything): the dirty-domain
// SQL and the upstream rule rely on this order.
export const domainDeclarations = [
  { kind: 'calculation', label: 'Moodle history index', name: 'history_index' },
  { kind: 'calculation', label: 'Enrollment counts', name: 'enrollments' },
  { kind: 'publication', label: 'Publication', name: 'publication' },
] as const;

export type CalculationDomain = CalculationDeclaration['name'];

export type Domain = Declaration['name'];

type CalculationDeclaration = Extract<Declaration, { kind: 'calculation' }>;

type Declaration = (typeof domainDeclarations)[number];

const isCalculationDeclaration = (
  declaration: Declaration,
): declaration is CalculationDeclaration => declaration.kind === 'calculation';

export const coordinationDomains: readonly Domain[] = domainDeclarations.map(
  ({ name }) => name,
);

export const calculationDomains: readonly CalculationDomain[] =
  domainDeclarations.filter(isCalculationDeclaration).map(({ name }) => name);

// A claim that is no work domain: the promotion of a staged Moodle
// snapshot. It is never pending, never dirty and never completed through
// `complete`; the promotion takes and clears it itself.
const snapshotClaim = {
  label: 'Snapshot promotion',
  name: 'snapshot',
} as const;

export type ClaimDomain = Domain | typeof snapshotClaim.name;

export const claimDomains: readonly ClaimDomain[] = [
  ...coordinationDomains,
  snapshotClaim.name,
];

// What a claim may name besides a domain: the first pending calculation
// domain in dependency order. The scheduled Flow claims it every tick;
// publication is never picked that way, only its own Flow claims it.
export const nextCalculation = 'next_calculation';

export type ClaimTarget = Domain | typeof nextCalculation;

export const claimTargets: readonly ClaimTarget[] = [
  ...coordinationDomains,
  nextCalculation,
];

export const isDomain = (value: unknown): value is Domain =>
  typeof value === 'string' &&
  (coordinationDomains as readonly string[]).includes(value);

export const isClaimDomain = (value: unknown): value is ClaimDomain =>
  typeof value === 'string' &&
  (claimDomains as readonly string[]).includes(value);

export const isCalculation = (value: unknown): value is CalculationDomain =>
  typeof value === 'string' &&
  (calculationDomains as readonly string[]).includes(value);

// The kind of a claim domain, which names the fingerprint it runs under: a
// declared domain's own kind, the calculation fingerprint for a snapshot
// promotion (and a claim without a known domain).
export const kindOf = (domain: ClaimDomain | null): DomainKind =>
  domainDeclarations.find(({ name }) => name === domain)?.kind ?? 'calculation';

// The label Studio and the status show for a claim domain.
export const domainLabel = (domain: ClaimDomain): string =>
  domainDeclarations.find(({ name }) => name === domain)?.label ??
  snapshotClaim.label;

// Keeps only known domains, once each, in dependency order.
export const normaliseDomains = (values: readonly unknown[]): Domain[] =>
  coordinationDomains.filter((domain) => values.includes(domain));

// Every action the coordinator operation accepts; options.ts validates
// exactly these (a test keeps the two in step). `record` keeps the outcome
// of one published file as soon as the publish loop knows it.
export const coordinatorActionNames = [
  'mark',
  'claim',
  'plan_pages',
  'stage_page',
  'index_page',
  'complete',
  'fail',
  'heartbeat',
  'record',
  'status',
] as const;

// The states of a Moodle snapshot import (data_operations.import_state).
export const importStates = [
  'idle',
  'importing',
  'validating',
  'ready',
  'promoting',
  'completed',
  'failed',
] as const;

export type ImportState = (typeof importStates)[number];

// The publication states of data_operations.publication_state: completed
// only when every declared file was uploaded and the revision recorded;
// partial when the run failed after some files were recorded uploaded at
// its revision; failed when none was.
export const publicationStates = [
  'idle',
  'running',
  'completed',
  'partial',
  'failed',
] as const;

export type PublicationState = (typeof publicationStates)[number];

// The outcome of one declared file in a publication: uploaded, failed (the
// upload was attempted and refused, or never answered), or skipped (not
// attempted because the claim could not be kept).
export const fileOutcomes = ['uploaded', 'failed', 'skipped'] as const;

export type FileOutcome = (typeof fileOutcomes)[number];
