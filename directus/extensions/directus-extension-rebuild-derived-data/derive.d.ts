export type CourseSources = {
  readonly courseEnrollmentPatterns: readonly DataRow[];
  readonly courseEquivalencies: readonly DataRow[];
  readonly courses: readonly DataRow[];
  readonly curriculum2018: readonly DataRow[];
  readonly curriculum2023: readonly DataRow[];
  readonly moodleUsers: readonly DataRow[];
  readonly teachingAssignments: readonly DataRow[];
};

export type DataRow = Readonly<Record<string, unknown>>;

export type StudentCouncilSources = {
  readonly members: readonly DataRow[];
  readonly students: readonly DataRow[];
};

export declare const academicYears: readonly string[];

export declare class DerivedDataError extends Error {
  name = 'DerivedDataError';
}

export declare const deriveCourses: (
  sources: CourseSources,
) => Promise<readonly DataRow[]>;

export declare const deriveStudentCouncil: (
  sources: StudentCouncilSources,
) => readonly DataRow[];
