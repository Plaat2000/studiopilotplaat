import { createCanvas, CanvasError, joinSession } from '@github/copilot-sdk/extension';
import { createControl } from './control.mjs';
import { startServer } from './server.mjs';
import { createThemeStore } from './themes.mjs';

const instances = new Map();
let session;
const themes = createThemeStore();
function instance(id) {
  const value = instances.get(id);
  if (!value) throw new CanvasError('NOT_OPEN', 'Open the LivePilot panel first.');
  return value;
}

const canvas = createCanvas({
  id: 'livepilot-control',
  displayName: 'Countryside Creative Studio',
  description: 'Explore grouped tracks, creative memory and taste, and approve Composer steps individually.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { themeDirectories: { type: 'array', maxItems: 20, items: { type: 'string' } } },
  },
  actions: [
    {
      name: 'creative-scan',
      description: 'Read all tracks, devices, and meters into the creative dashboard without changing playback.',
      handler: ({ instanceId }) => instance(instanceId).control.creative({ action: 'scan' }),
    },
    {
      name: 'catalog',
      description: 'List architecture modules and their supported commands and input fields.',
      handler: ({ instanceId }) => instance(instanceId).control.catalog(),
    },
    {
      name: 'refresh',
      description: 'Read the live Ableton session without changing it.',
      handler: async ({ instanceId }) => instance(instanceId).control.refresh(),
    },
    {
      name: 'inspect-track',
      description: 'Read a track and optionally its device parameters.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['track_index'],
        properties: {
          track_index: { type: 'integer', minimum: -1000 },
          device_index: { type: 'integer', minimum: 0 },
        },
      },
      handler: async ({ instanceId, input }) => instance(instanceId).control.inspect(input),
    },
  ],
  open: async ({ instanceId, input }) => {
    try {
      if (input?.themeDirectories !== undefined) await themes.configure(input.themeDirectories);
      await themes.catalog();
    } catch (error) { throw new CanvasError('THEME_STORAGE_ERROR', error.message); }
    if (!instances.has(instanceId)) {
      const control = createControl({
        get rpc() {
          if (!session) throw new CanvasError('NOT_READY', 'LivePilot panel is initializing. Press Refresh session.');
          return session.rpc;
        },
      });
      try {
        instances.set(instanceId, { control, ...await startServer(control, themes) });
      } catch (error) {
        throw new CanvasError('OPEN_FAILED', error.message);
      }
    }
    return { url: instance(instanceId).url, title: 'Countryside Creative Studio' };
  },
  onClose: async ({ instanceId }) => {
    const current = instances.get(instanceId);
    if (current) {
      await current.close();
      instances.delete(instanceId);
    }
  },
});

session = await joinSession({ canvases: [canvas] });
