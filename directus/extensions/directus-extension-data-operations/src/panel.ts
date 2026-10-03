import { definePanel } from '@directus/extensions-sdk';

import {
  managedFlowFilter,
  managedFlowNote,
  runOperationPanelId,
} from './managed-flows.js';
import RunOperationPanel from './panel.vue';

// The generic Run operation panel: its one option picks an installed
// manual Flow of a managed family; the panel renders that Flow's own
// confirmation text and fields and posts them to the native
// POST /flows/trigger/:id. Any later Data / or Publish / Flow goes on a
// dashboard with this panel and no code change.
export default definePanel({
  component: RunOperationPanel,
  description:
    'Runs one data operation Flow with its own confirmation and fields.',
  icon: 'play_circle',
  id: runOperationPanelId,
  minHeight: 8,
  minWidth: 12,
  name: 'Run operation',
  options: [
    {
      field: 'flow',
      meta: {
        interface: 'collection-item-dropdown',
        note: managedFlowNote,
        options: {
          filter: managedFlowFilter,
          selectedCollection: 'directus_flows',
          template: '{{ name }}',
        },
        required: true,
        width: 'full',
      },
      name: 'Flow',
      type: 'json',
    },
  ],
});
