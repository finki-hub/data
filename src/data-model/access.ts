import { z } from 'zod';

import type { DirectusRequest } from '../directus-request.js';
import type { ModelCollectionKey } from '../schema.js';

// Who may read what without signing in: the public policy and the MCP
// read-only policy (the role of the MCP server's static token) read exactly
// these collections and fields. Everything else (the Moodle users and their
// mappings, every student outside the council, the operations bookkeeping)
// stays private. Setup creates a missing read permission and keeps an
// existing one as it is, like every other Studio-owned setting.

export type PublicRead = {
  readonly collection: ModelCollectionKey;
  // The readable fields, or every field.
  readonly fields: '*' | readonly string[];
  readonly filter?: Readonly<Record<string, unknown>>;
};

export const publicReads: readonly PublicRead[] = [
  // Not the Moodle mappings of a year.
  {
    collection: 'academic_years',
    fields: ['id', 'label', 'published', 'enrollments'],
  },
  { collection: 'anto_quotes', fields: '*' },
  { collection: 'bachelor_thesis_staff', fields: '*' },
  { collection: 'bachelor_theses', fields: '*' },
  { collection: 'course_accreditation_staff', fields: '*' },
  { collection: 'course_curricula', fields: '*' },
  // Not the calculation's internal revision.
  {
    collection: 'course_enrollments',
    fields: ['id', 'course', 'academic_year', 'count', 'computed_at'],
  },
  { collection: 'course_equivalencies', fields: '*' },
  { collection: 'course_equivalency_members', fields: '*' },
  { collection: 'course_teaching', fields: '*' },
  // Not the Moodle mappings and history lines of a course.
  {
    collection: 'courses',
    fields: [
      'id',
      'name',
      'name_en',
      'status',
      'tags',
      'curricula',
      'enrollments',
      'equivalencies',
      'assignments',
      'overview',
      'curriculum',
      'staff',
      'enrollment',
      'discord_channels',
      'abbreviation',
      'degree_cycle',
      'objectives',
      'objectives_en',
      'content',
      'content_en',
      'syllabus',
      'teaching',
      'accreditation_staff',
      'slots',
    ],
  },
  {
    collection: 'curriculum_entries',
    fields: [
      'id',
      'generation',
      'name',
      'catalog_order',
      'url',
      'code',
      'semester',
      'prerequisites',
      'channel',
      'program_states',
      'equivalency_memberships',
      'course_links',
    ],
  },
  { collection: 'curriculum_entry_program_states', fields: '*' },
  {
    collection: 'curriculum_generations',
    fields: ['id', 'code', 'label', 'has_curriculum', 'published', 'programs'],
  },
  { collection: 'deans_office', fields: '*' },
  { collection: 'discord_channel_courses', fields: '*' },
  { collection: 'discord_channels', fields: '*' },
  { collection: 'exam_sessions', fields: '*' },
  { collection: 'master_thesis_staff', fields: '*' },
  { collection: 'master_theses', fields: '*' },
  { collection: 'room_aliases', fields: '*' },
  { collection: 'rooms', fields: '*' },
  { collection: 'staff', fields: '*' },
  { collection: 'student_council', fields: '*' },
  // Council members only, by name and index number.
  {
    collection: 'students',
    fields: ['id', 'name', 'index_number', 'council_memberships'],
    filter: { council_memberships: { _some: { id: { _nnull: true } } } },
  },
  { collection: 'study_programs', fields: '*' },
  { collection: 'teaching_assignments', fields: '*' },
  { collection: 'timetable_lessons', fields: '*' },
  { collection: 'timetable_slots', fields: '*' },
  { collection: 'timetables', fields: '*' },
];

// The policy and role of the MCP server's token.
export const mcpAccess = {
  icon: 'smart_toy',
  policy: 'MCP read-only',
  role: 'MCP',
} as const;

export type AccessInstallSummary = {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
};

const idRows = z.array(z.object({ id: z.string() }));
const policyRows = z.array(z.object({ policy: z.string() }));
const collectionRows = z.array(z.object({ collection: z.string() }));

const firstId = async (
  request: DirectusRequest,
  path: string,
): Promise<string | undefined> => idRows.parse(await request(path))[0]?.id;

// The policy Directus applies to anonymous requests.
const publicPolicy = async (request: DirectusRequest): Promise<string> => {
  const [row] = policyRows.parse(
    await request(
      '/access?fields=policy&limit=1&filter[role][_null]=true&filter[user][_null]=true',
    ),
  );
  if (row === undefined) {
    throw new Error('Directus has no public policy');
  }
  return row.policy;
};

// The MCP policy, created with its role when missing.
const mcpPolicy = async (
  request: DirectusRequest,
  created: string[],
): Promise<string> => {
  const name = encodeURIComponent(mcpAccess.policy);
  const existing = await firstId(
    request,
    `/policies?fields=id&limit=1&filter[name][_eq]=${name}`,
  );
  if (existing !== undefined) {
    return existing;
  }
  const roleName = encodeURIComponent(mcpAccess.role);
  const role =
    (await firstId(
      request,
      `/roles?fields=id&limit=1&filter[name][_eq]=${roleName}`,
    )) ??
    z.object({ id: z.string() }).parse(
      await request('/roles', {
        body: JSON.stringify({ icon: mcpAccess.icon, name: mcpAccess.role }),
        method: 'POST',
      }),
    ).id;
  const policy = z.object({ id: z.string() }).parse(
    await request('/policies', {
      body: JSON.stringify({
        admin_access: false,
        app_access: false,
        icon: mcpAccess.icon,
        name: mcpAccess.policy,
      }),
      method: 'POST',
    }),
  ).id;
  await request('/access', {
    body: JSON.stringify({ policy, role }),
    method: 'POST',
  });
  created.push(`policy ${mcpAccess.policy}`);
  return policy;
};

const permissionOf = (policy: string, read: PublicRead) => ({
  action: 'read',
  collection: read.collection,
  fields: read.fields === '*' ? ['*'] : [...read.fields],
  permissions: read.filter ?? {},
  policy,
  validation: {},
});

// Creates every missing public and MCP read permission.
export const installPublicAccess = async (
  request: DirectusRequest,
): Promise<AccessInstallSummary> => {
  const created: string[] = [];
  const skipped: string[] = [];
  const policies = [
    { label: 'public', policy: await publicPolicy(request) },
    { label: 'mcp', policy: await mcpPolicy(request, created) },
  ];
  for (const { label, policy } of policies) {
    const readable = new Set(
      collectionRows
        .parse(
          await request(
            `/permissions?fields=collection&limit=-1&filter[policy][_eq]=${policy}&filter[action][_eq]=read`,
          ),
        )
        .map(({ collection }) => collection),
    );
    const missing = publicReads.filter(
      ({ collection }) => !readable.has(collection),
    );
    for (const read of publicReads) {
      (readable.has(read.collection) ? skipped : created).push(
        `${label} ${read.collection}`,
      );
    }
    if (missing.length > 0) {
      await request('/permissions', {
        body: JSON.stringify(missing.map((read) => permissionOf(policy, read))),
        method: 'POST',
      });
    }
  }
  return { created, skipped };
};
