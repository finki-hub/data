const courseFields = [
  ['name', 'name'],
  ['professors', 'professors'],
  ['enrollment_2025_2026', '2025/2026'],
  ['enrollment_2024_2025', '2024/2025'],
  ['enrollment_2023_2024', '2023/2024'],
  ['enrollment_2022_2023', '2022/2023'],
  ['enrollment_2021_2022', '2021/2022'],
  ['enrollment_2020_2021', '2020/2021'],
  ['enrollment_2019_2020', '2019/2020'],
  ['enrollment_2018_2019', '2018/2019'],
  ['enrollment_2017_2018', '2017/2018'],
  ['enrollment_2016_2017', '2016/2017'],
  ['enrollment_2015_2016', '2015/2016'],
  ['enrollment_2014_2015', '2014/2015'],
  ['enrollment_2013_2014', '2013/2014'],
  ['enrollment_2012_2013', '2012/2013'],
  ['enrollment_2011_2012', '2011/2012'],
  ['available_2023', '2023-available'],
  ['available_2018', '2018-available'],
  ['channel', 'channel'],
  ['tags', 'tags'],
  ['assistants', 'assistants'],
  ['name_2023', '2023-name'],
  ['code_2023', '2023-code'],
  ['level_2023', '2023-level'],
  ['semester_2023', '2023-semester'],
  ['channel_2023', '2023-channel'],
  ['prerequisite_2023', '2023-prerequisite'],
  ['state_kn_2023', '2023-state-kn'],
  ['state_siis_2023', '2023-state-siis'],
  ['state_pit_2023', '2023-state-pit'],
  ['state_imb_2023', '2023-state-imb'],
  ['state_ki_2023', '2023-state-ki'],
  ['state_ie_2023', '2023-state-ie'],
  ['state_ssp_2023', '2023-state-ssp'],
  ['state_seis_2023', '2023-state-seis'],
  ['credits_2023', '2023-credits'],
  ['name_2018', '2018-name'],
  ['code_2018', '2018-code'],
  ['level_2018', '2018-level'],
  ['semester_2018', '2018-semester'],
  ['channel_2018', '2018-channel'],
  ['prerequisite_2018', '2018-prerequisite'],
  ['credits_2018', '2018-credits'],
  ['state_kn_2018', '2018-state-kn'],
  ['state_siis_2018', '2018-state-siis'],
  ['state_pit_2018', '2018-state-pit'],
  ['state_imb_2018', '2018-state-imb'],
  ['state_ki_2018', '2018-state-ki'],
  ['state_ke_2018', '2018-state-ke'],
  ['state_seis_2018', '2018-state-seis'],
];

const staffFields = [
  ['name', 'name'],
  ['active', 'active'],
  ['title', 'title'],
  ['position', 'position'],
  ['email', 'email'],
  ['cabinet', 'cabinet'],
  ['profile', 'profile'],
  ['courses', 'courses'],
  ['consultations', 'consultations'],
];

const roomFields = [
  ['name', 'name'],
  ['type', 'type'],
  ['location', 'location'],
  ['description', 'description'],
  ['floor', 'floor'],
  ['capacity', 'capacity'],
  ['mrbs', 'mrbs'],
];

const studentFields = [
  ['index_number', 'index'],
  ['name', 'name'],
];

const numericBooleans = new Set(['active', 'channel_2018', 'channel_2023']);

const serializeValue = (field, value) => {
  if (typeof value === 'boolean') {
    if (numericBooleans.has(field)) {
      return value ? '1' : '0';
    }

    return value ? 'TRUE' : 'FALSE';
  }

  return typeof value === 'number' ? String(value) : value;
};

const serializeRows = (rows, fields) => {
  if (!Array.isArray(rows)) {
    throw new TypeError('Expected a Directus Read Data result');
  }

  return rows.map((row) => {
    const output = {};
    for (const [field, outputField] of fields) {
      const value = row[field];
      if (value !== null && value !== undefined && value !== '') {
        output[outputField] = serializeValue(field, value);
      }
    }

    return output;
  });
};

const serializeAssets = (data) => ({
  courses: serializeRows(data.read_courses, courseFields),
  rooms: serializeRows(data.read_rooms, roomFields),
  staff: serializeRows(data.read_staff, staffFields),
  students: serializeRows(data.read_students, studentFields),
});

module.exports = serializeAssets;
