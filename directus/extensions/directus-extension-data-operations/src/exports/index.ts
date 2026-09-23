import type { ExportDefinition } from './types.js';

import { courses } from './courses.js';
import { rooms } from './rooms.js';
import { staff } from './staff.js';
import { students } from './students.js';

// Every published file, in publication order. Changing a file's format is
// editing its definition module; adding a file is adding a module and
// listing it here. Nothing else (no Flow, no schema) changes with them.
export const exportDefinitions: readonly ExportDefinition[] = [
  courses,
  rooms,
  staff,
  students,
];
