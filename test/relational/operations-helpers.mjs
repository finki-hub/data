// The helpers of the operations scenario (operations.integration.mjs) and
// the publish and restore suites: requests as a given caller, a Flow run
// the way the Run operation panel posts it, and the keys of an answer.

// One request as a caller (a static token, or none for anonymous): the
// status and the parsed body, never an assertion.
export const callAs = async (target, token, { body, method = 'GET', path }) => {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(new URL(path, target.base), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  return {
    body: text === '' ? null : JSON.parse(text),
    status: response.status,
  };
};

export const codeOf = (answer) =>
  answer.body?.errors?.[0]?.extensions?.code ?? null;

// POST /flows/trigger/:id the way the Run operation panel posts it.
export const runFlow = (target, token, { id, values = {} }) =>
  callAs(target, token, {
    body: { ...values, collection: 'data_operations' },
    method: 'POST',
    path: `/flows/trigger/${id}`,
  });

// The keys of an object tree, at any depth.
export const keysDeep = (value) => {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysDeep(inner),
  ]);
};
