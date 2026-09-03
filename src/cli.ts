import { ZodError } from 'zod';

import type { MigrationData } from './schema.js';

import { loadConfig } from './config.js';
import { DirectusClient } from './directus.js';
import { loadMigrationData } from './workbook.js';

const counts = (
  data: MigrationData,
): Readonly<Record<keyof MigrationData, number>> => ({
  course_enrollment_patterns: data.course_enrollment_patterns.length,
  course_equivalencies: data.course_equivalencies.length,
  courses: data.courses.length,
  curriculum_2018: data.curriculum_2018.length,
  curriculum_2023: data.curriculum_2023.length,
  deans_office: data.deans_office.length,
  discord_channels: data.discord_channels.length,
  moodle_users: data.moodle_users.length,
  rooms: data.rooms.length,
  staff: data.staff.length,
  student_council: data.student_council.length,
  students: data.students.length,
  teaching_assignments: data.teaching_assignments.length,
});

const main = async (): Promise<void> => {
  const config = loadConfig(process.argv.slice(2), process.env);
  const data = await loadMigrationData(config.workbookPath);

  if (config.dryRun) {
    process.stdout.write(`${JSON.stringify(counts(data), null, 2)}\n`);
    return;
  }

  if (config.directus === null) {
    throw new Error('Directus configuration is required outside dry-run mode');
  }

  await new DirectusClient(config.directus).import(data);
  process.stdout.write(`Imported ${JSON.stringify(counts(data))}\n`);
};

try {
  await main();
} catch (error) {
  const message = error instanceof ZodError ? error.message : String(error);
  process.stderr.write(`Import failed: ${message}\n`);
  process.exitCode = 1;
}
