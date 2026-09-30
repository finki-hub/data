// The bounds of a Search request, declared once for the endpoint that
// enforces them and the layout that shows them. This module imports
// nothing, so both bundles read it.

// Matching users per page.
export const pageSize = 50;

// Courses per group (required or excluded).
export const courseLimit = 20;

// Characters of one course name.
export const courseNameLength = 2_000;

// Characters of the page header search.
export const searchLength = 1_000;
