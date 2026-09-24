import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';

import { stateKey } from './curricula.js';
import { type ExistingMember, memberKey } from './equivalency-members.js';
import { programKey } from './generations.js';
import { indexed } from './target-reads.js';

// The curriculum generation, study program, program state and equivalency
// member rows a converter step reads fresh when it starts, keyed the way
// the converters look them up (see target-reads.ts).

const id = z.number().int();
const text = z.string().nullable();
const integer = z.number().int().nullable();

const generationRow = z.object({ code: text, id });

// The generation rows by code.
export const readGenerationIds = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, number>> =>
  indexed(
    request,
    { collection: 'curriculum_generations', schema: generationRow },
    (row) => (row.code === null ? [] : [[row.code, row.id]]),
  );

const programRow = z.object({ code: text, generation: integer, id });

// The study programs by generation id and code.
export const readProgramIds = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, number>> =>
  indexed(
    request,
    { collection: 'study_programs', schema: programRow },
    (row) =>
      row.code === null || row.generation === null
        ? []
        : [[programKey(row.generation, row.code), row.id]],
  );

const stateRow = z.object({ entry: integer, id, program: integer });

// The program states by entry and program.
export const readStateIds = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, number>> =>
  indexed(
    request,
    { collection: 'curriculum_entry_program_states', schema: stateRow },
    (row) =>
      row.entry === null || row.program === null
        ? []
        : [[stateKey(row.entry, row.program), row.id]],
  );

const memberRow = z.object({
  entry: integer,
  equivalency: integer,
  generation: integer,
  id,
});

// The equivalency members by equivalency and generation, with the entry
// each one links, so a link set by hand is recognised, not adopted.
export const readMembers = (
  request: DirectusRequest,
): Promise<ReadonlyMap<string, ExistingMember>> =>
  indexed(
    request,
    { collection: 'course_equivalency_members', schema: memberRow },
    (row) =>
      row.equivalency === null || row.generation === null
        ? []
        : [
            [
              memberKey(row.equivalency, row.generation),
              { entry: row.entry, id: row.id },
            ],
          ],
  );
