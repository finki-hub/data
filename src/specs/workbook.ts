import { privateWorkbookSpecs } from './private.js';
import { publicWorkbookSpecs } from './public.js';
import { referenceWorkbookSpecs } from './reference.js';

// Every part of the workbook the one-time import reads, in reading order.
export const workbookSpecs = [
  ...publicWorkbookSpecs,
  ...referenceWorkbookSpecs,
  ...privateWorkbookSpecs,
] as const;
