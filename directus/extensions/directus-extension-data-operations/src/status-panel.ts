import { definePanel } from '@directus/extensions-sdk';

import {
  dataStatusPanelId,
  statusSectionLabels,
  statusSections,
} from './managed-flows.js';
import DataStatusPanel from './status-panel.vue';

// The generic status panel: the domains, the per-file publication outcomes,
// the readiness checks and the published key-source rows, read from the
// authorized status endpoint as lists (a new domain, file, check or key
// source shows with no change here). Its option picks the sections.
export default definePanel({
  component: DataStatusPanel,
  description:
    'Shows the data status: calculations, published files, readiness checks and published keys.',
  icon: 'monitor_heart',
  id: dataStatusPanelId,
  minHeight: 10,
  minWidth: 16,
  name: 'Data status',
  options: [
    {
      field: 'sections',
      meta: {
        interface: 'select-multiple-checkbox',
        note: 'Every section when none is chosen.',
        options: {
          choices: statusSections.map((value) => ({
            text: statusSectionLabels[value],
            value,
          })),
        },
        width: 'full',
      },
      name: 'Sections',
      type: 'json',
    },
  ],
});
