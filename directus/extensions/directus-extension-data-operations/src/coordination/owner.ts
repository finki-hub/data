import { randomUUID } from 'node:crypto';

// The identity of this Directus process. It is minted once when the bundle
// loads, recorded on every claim, and never survives a restart: a claim
// whose owner is gone stops heartbeating and is released as abandoned.
export const processOwner = randomUUID();
