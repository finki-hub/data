import {
  field,
  requiredField,
  schemaField,
  type WorkbookSpec,
} from '../schema.js';

// The workbook's Courses sheet, the first Moodle users snapshot. Its
// fields are the columns of the Moodle users model as well
// (src/data-model/moodle-collections.ts); the scraper-only columns have no
// header here.
export const privateWorkbookSpecs = [
  {
    fields: [
      schemaField('ID_old', 'integer'),
      field('ID', 'ID_new', 'integer'),
      requiredField('Name', 'Name'),
      field('Mail', 'Mail'),
      field('Courses', 'Courses', 'text'),
      field('#', 'Courses Count', 'integer'),
      schemaField('Profile_old', 'text'),
      field('Profile', 'Profile_new', 'text'),
      field('AIM_new', 'AIM_new'),
      field('AIM_old', 'AIM_old'),
      field('Avatar_new', 'Avatar_new', 'text'),
      field('Avatar_old', 'Avatar_old', 'text'),
      field('City_new', 'City_new'),
      field('City_old', 'City_old'),
      field('Country_new', 'Country_new'),
      field('Country_old', 'Country_old'),
      field('Description_new', 'Description_new', 'text'),
      field('Description_old', 'Description_old', 'text'),
      field('ICQ_new', 'ICQ_new'),
      field('ICQ_old', 'ICQ_old'),
      field('Images_new', 'Images_new', 'text'),
      field('Images_old', 'Images_old', 'text'),
      field('Interests_new', 'Interests_new', 'text'),
      field('Interests_old', 'Interests_old', 'text'),
      field('Last Access_new', 'Last Access_new'),
      field('Last Access_old', 'Last Access_old'),
      field('MSN_new', 'MSN_new'),
      field('MSN_old', 'MSN_old'),
      field('MoodleNet_new', 'MoodleNet_new'),
      field('MoodleNet_old', 'MoodleNet_old'),
      field('Skype_new', 'Skype_new'),
      field('Skype_old', 'Skype_old'),
      schemaField('Timezone_new'),
      schemaField('Timezone_old'),
      field('Web_new', 'Web_new', 'text'),
      field('Web_old', 'Web_old', 'text'),
      field('Yahoo_new', 'Yahoo_new'),
      field('Yahoo_old', 'Yahoo_old'),
    ],
    key: 'moodle_users',
    source: { kind: 'rows', sheet: 'Courses' },
  },
] as const satisfies readonly WorkbookSpec[];
