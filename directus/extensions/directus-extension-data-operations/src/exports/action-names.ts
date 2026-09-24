// The actions of the export operation, declared once without zod so the
// Studio form (exports-app.ts) lists exactly what actions.ts accepts:
// readiness answers whether the public files can be prepared now; prepare
// reads, serializes and validates every file and answers their sizes and
// digests; stage does the same for a publication that holds its claim and
// hands every file to the publish loop, one upload per file; outcomes folds
// the loop's answers into one outcome per declared file. None of them
// uploads anything.
export const exportActions = [
  'readiness',
  'prepare',
  'stage',
  'outcomes',
] as const;

export type ExportAction = (typeof exportActions)[number];
