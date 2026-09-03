const operation = {
  description: 'Writes stable JSON files to a Directus storage location.',
  icon: 'cloud_upload',
  id: 'finki-hub-publish-json',
  name: 'Publish JSON files',
  options: [
    {
      field: 'storage',
      meta: {
        interface: 'input',
        required: true,
        width: 'full',
      },
      name: 'Storage location',
      type: 'string',
    },
    {
      field: 'objects',
      meta: {
        interface: 'input-code',
        note: 'A map of object filenames to JSON values.',
        options: { language: 'json' },
        required: true,
        width: 'full',
      },
      name: 'Objects',
      type: 'json',
    },
  ],
  overview: ({ storage }) => [
    {
      label: 'Storage',
      text: storage ?? '--',
    },
  ],
};

export default operation;
