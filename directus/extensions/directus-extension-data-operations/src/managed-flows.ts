// The dashboard's contract with the managed Flows and the status read,
// declared once for the Studio panels, the status endpoint and setup. This
// module imports nothing and uses no zod, so the Studio app bundle can
// read it.

// The name prefix of every manual Flow a dashboard panel may run: the data
// operations (`Data / ...`) and the publication (`Publish / ...`). An
// administrator who adds a manual Flow with such a name in Studio can put
// it on the dashboard with no code change. The prefix is a convenience of
// the panel's Flow picker, never the access boundary. The trigger endpoint
// lets anyone run a manual Flow who may read its collection, so every
// installed managed Flow starts with a Condition on the administrator flag
// that rejects into a 403 Throw Error, and a Flow an administrator adds
// needs the same first step (README, "Data operations dashboard").
export const managedFlowPrefixes = ['Data / ', 'Publish / '] as const;

// The one collection a panel runs a managed Flow on: the hidden Data
// Operations singleton, which only administrators read, so the trigger
// endpoint refuses every non-administrator before such a Flow starts. A
// Flow on another collection would rest on its own first step alone.
export const operationsCollection = 'data_operations';

export const isManagedFlowName = (name: string): boolean =>
  managedFlowPrefixes.some((prefix) => name.startsWith(prefix));

// The Studio filter of the panel's Flow option: installed manual Flows of a
// managed family.
export const managedFlowFilter = {
  _and: [
    { trigger: { _eq: 'manual' } },
    {
      _or: managedFlowPrefixes.map((prefix) => ({
        name: { _starts_with: prefix },
      })),
    },
  ],
} as const;

// The note of the panel's Flow option: the Flows it offers.
export const managedFlowNote = `Installed manual Flow named ${managedFlowPrefixes
  .map((prefix) => `"${prefix}…"`)
  .join(' or ')}.`;

// The panel types of the bundle.
export const runOperationPanelId = 'finki-hub-run-operation';
export const dataStatusPanelId = 'finki-hub-data-status-panel';

// The endpoint the status panel reads: `/` the status, `/readiness` the
// readiness checks.
export const statusEndpointId = 'finki-hub-data-status';
export const statusPath = `/${statusEndpointId}`;
export const readinessPath = `${statusPath}/readiness`;

// The parts of the data status a status panel shows; a panel lists any of
// them, in this order.
export const statusSections = ['operations', 'readiness', 'keys'] as const;

export type StatusSection = (typeof statusSections)[number];

// The sections a panel's option names, in declaration order; every
// section when it names none.
export const sectionsOf = (option: unknown): StatusSection[] => {
  const named = Array.isArray(option)
    ? statusSections.filter((section) => option.includes(section))
    : [];
  return named.length > 0 ? named : [...statusSections];
};

// The section names are the names of the default panels that show them.
export const statusSectionLabels: Readonly<Record<StatusSection, string>> = {
  keys: 'Published keys',
  operations: 'Calculations and published files',
  readiness: 'Readiness',
};

// How far back the status looks for the last run of a scheduled Flow; the
// dashboard names the window when a Flow has not run in it.
export const scheduleLookBackMinutes = 60;

// The Studio page of a collection, of one of its rows and of a bookmark,
// as routes of the Studio app (it serves them under /admin).
export const collectionPage = (collection: string): string =>
  `/content/${collection}`;

export const itemPage = (collection: string, id: number | string): string =>
  `${collectionPage(collection)}/${encodeURIComponent(String(id))}`;

export const bookmarkPage = (collection: string, id: number): string =>
  `${collectionPage(collection)}?bookmark=${String(id)}`;

export const flowSettingsPage = (id: string): string => `/settings/flows/${id}`;

const wordStart = /(?<=[\da-z])(?=[A-Z])/gu;

// "academic_years" as "Academic years", "previousRows" as "Previous rows".
export const humanize = (key: string): string => {
  const words = key
    .replaceAll(wordStart, ' ')
    .replaceAll('_', ' ')
    .trim()
    .toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};
