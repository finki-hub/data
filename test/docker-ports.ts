import { z } from 'zod';

// Generic reads of Docker's output for the isolated test targets.

const portLinePattern = /^(?<inner>\d+)\/tcp -> (?<published>\S+)$/u;

// The container port `docker port <container>` shows published on a host
// and port ("9090/tcp -> 127.0.0.1:19090"), or null when none is.
export const containerPortOf = (
  portOutput: string,
  host: string,
  port: string,
): null | string => {
  for (const line of portOutput.split('\n')) {
    const groups = portLinePattern.exec(line.trim())?.groups;
    if (groups?.['published'] === `${host}:${port}`) {
      return groups['inner'] ?? null;
    }
  }
  return null;
};

const networksSchema = z.record(
  z.string(),
  z.object({
    Aliases: z.array(z.string()).nullable().optional(),
    DNSNames: z.array(z.string()).nullable().optional(),
  }),
);

// The names the Directus container can reach another container by (the
// database): its container name and its aliases on
// each network the two share (both read as `docker inspect --format
// '{{json .NetworkSettings.Networks}}'`). No shared network, no name.
export const hostsOf = (
  container: { readonly name: string; readonly networks: unknown },
  directusNetworks: unknown,
): string[] => {
  const reachable = new Set(
    Object.keys(networksSchema.parse(directusNetworks)),
  );
  const shared = Object.entries(
    networksSchema.parse(container.networks),
  ).filter(([network]) => reachable.has(network));
  if (shared.length === 0) {
    return [];
  }
  return [
    container.name,
    ...shared.flatMap(([, { Aliases, DNSNames }]) => [
      ...(Aliases ?? []),
      ...(DNSNames ?? []),
    ]),
  ];
};
