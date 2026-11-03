export function decodeResult(result, allowText = false) {
  if (typeof result === 'object' && result !== null && 'resultType' in result) {
    if (result.resultType !== 'success') {
      throw new Error(result.error || result.textResultForLlm || 'LivePilot command failed.');
    }
    result = result.structuredContent ?? result.textResultForLlm;
  }
  if (typeof result === 'string') {
    try { result = JSON.parse(result); }
    catch {
      if (allowText) return { documentation: result };
      throw new Error(`Unexpected LivePilot response: ${result.slice(0, 400)}`);
    }
  }
  if (result?.isError || result?.ok === false || result?.error) {
    throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result));
  }
  if (Array.isArray(result?.content)) {
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return decodeResult(text, allowText);
  }
  if (result && typeof result === 'object' && Object.keys(result).length === 1 && 'result' in result) {
    return decodeResult(result.result, allowText);
  }
  if (!result || typeof result !== 'object') throw new Error('LivePilot returned no structured result.');
  return result;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
}
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}
function index(value, min = 0) {
  number(value, min, Number.MAX_SAFE_INTEGER, 'Index');
  if (!Number.isInteger(value)) throw new Error('Index must be an integer.');
  return value;
}
function sameTrack(a, b) {
  return a.name === b.name && a.index === b.index;
}

export function createControl(session) {
  let state = null;
  let inspected = null;
  let parameters = null;
  let queue = Promise.resolve();
  const exclusive = fn => {
    const pending = queue.then(fn);
    queue = pending.catch(() => {});
    return pending;
  };
  async function call(name, args = {}, allowText = false) {
    return invoke(name, args, allowText, true);
  }
  async function invoke(name, args, allowText, retryCatalogChange) {
    const metadata = await session.rpc.tools.getCurrentMetadata();
    const tools = metadata.tools || [];
    const liveTools = tools.filter(t =>
      /^livepilot(?:-dev)?$/i.test(t.mcpServerName || '') ||
      /^LivePilot-/i.test(t.name) || /^LivePilot-/i.test(t.namespacedName || ''));
    const direct = liveTools.find(t => t.mcpToolName === name || t.name === `LivePilot-${name}`);
    const gateway = liveTools.find(t => t.mcpToolName === 'call_tool' || t.name === 'LivePilot-call_tool');
    if (!direct && !gateway) throw new Error('LivePilot MCP is not available in this session.');
    try {
      const response = await session.rpc.tools.execute({
        name: (direct || gateway).name,
        arguments: direct ? args : { name, arguments: args },
      });
      return decodeResult(response, allowText);
    } catch (error) {
      if (retryCatalogChange && /^MCP tool catalog changed before tool "[^"]+" could be invoked\.?$/.test(error.message)) {
        return invoke(name, args, allowText, false);
      }
      throw error;
    }
  }
  async function refresh() {
    const next = await call('get_session_info');
    if (!Array.isArray(next.tracks) || typeof next.tempo !== 'number') {
      throw new Error('Unexpected LivePilot session shape.');
    }
    if (state && (state.session_instance_id !== next.session_instance_id || state.file_path !== next.file_path)) {
      inspected = null;
      parameters = null;
    }
    state = next;
    return snapshot();
  }
  function snapshot() {
    return { session: state, track: inspected, parameters };
  }
  async function inspect(input) {
    object(input);
    index(input.track_index, -1000);
    const track = await call('get_track_info', { track_index: input.track_index });
    inspected = { ...track, index: input.track_index };
    parameters = null;
    if (input.device_index !== undefined) {
      index(input.device_index);
      const device = track.devices?.find(d => d.index === input.device_index);
      if (!device) throw new Error('Device no longer exists. Refresh the track.');
      const result = await call('get_device_parameters', {
        track_index: input.track_index, device_index: input.device_index,
      });
      if (!Array.isArray(result.parameters)) throw new Error('Unexpected parameter response.');
      parameters = { device_index: input.device_index, device_name: device.name, items: result.parameters };
    }
    return snapshot();
  }
  async function command(input) {
    object(input);
    const { command: name } = input;
    if (['start_playback', 'stop_playback', 'undo', 'redo'].includes(name)) {
      await call(name);
      inspected = null;
      parameters = null;
    } else if (name === 'set_tempo') {
      number(input.value, 20, 999, 'Tempo');
      await call('get_session_info');
      await call(name, { tempo: input.value });
    } else if (['set_track_volume', 'set_track_pan', 'set_track_mute', 'set_track_solo', 'set_device_parameter'].includes(name)) {
      index(input.track_index, -1000);
      if (!inspected || inspected.index !== input.track_index) throw new Error('Read this track before editing.');
      if (input.track_name !== inspected.name) throw new Error('Track selection changed. Refresh before editing.');
      const latestSession = await call('get_session_info');
      if (!state || state.session_instance_id !== latestSession.session_instance_id || state.file_path !== latestSession.file_path) {
        throw new Error('Ableton set changed. Refresh before editing.');
      }
      const fresh = await call('get_track_info', { track_index: input.track_index });
      if (!sameTrack({ ...fresh, index: input.track_index }, inspected)) {
        throw new Error('Track changed. Refresh before editing.');
      }
      const args = { track_index: input.track_index };
      if (name === 'set_device_parameter') {
        index(input.device_index);
        index(input.parameter_index);
        if (!parameters || parameters.device_index !== input.device_index ||
            parameters.device_name !== input.device_name) throw new Error('Read this device before editing.');
        const device = fresh.devices?.find(d => d.index === input.device_index);
        if (!device || device.name !== parameters.device_name) throw new Error('Device changed. Refresh before editing.');
        const current = await call('get_device_parameters', { ...args, device_index: input.device_index });
        const previous = parameters.items.find(p => p.index === input.parameter_index);
        const parameter = current.parameters?.find(p => p.index === input.parameter_index);
        if (!previous || !parameter || parameter.name !== previous.name) throw new Error('Parameter changed. Refresh before editing.');
        number(input.value, parameter.min, parameter.max, parameter.name);
        if (parameter.is_enabled === false || parameter.min === parameter.max) throw new Error('Parameter is read-only.');
        if (parameter.is_quantized && !Number.isInteger(input.value)) throw new Error('Choose a discrete parameter value.');
        await call(name, { ...args, device_index: input.device_index, parameter_index: input.parameter_index, value: input.value });
        await inspect({ track_index: input.track_index, device_index: input.device_index });
      } else {
        if (name === 'set_track_volume') args.volume = number(input.value, 0, 1, 'Volume');
        if (name === 'set_track_pan') args.pan = number(input.value, -1, 1, 'Pan');
        if (name === 'set_track_mute' || name === 'set_track_solo') {
          if (typeof input.value !== 'boolean') throw new Error('Expected a boolean.');
          args[name === 'set_track_mute' ? 'muted' : 'solo'] = input.value;
        }
        await call(name, args);
        await inspect({ track_index: input.track_index });
      }
    } else throw new Error('Unsupported command.');
    return refresh();
  }
  const creative = createCreative(call);
  return {
    creative: input => exclusive(() => creative.run(input)),
    creativeSnapshot: creative.snapshot,
    catalog: () => ({ modules, discoveryTool }),
    query: input => exclusive(async () => {
      const { spec, args } = validateToolInput(input);
      return { tool: spec.name, timestamp: new Date().toISOString(),
        data: await call(spec.name, args, spec.name === 'search_tools') };
    }),
    refresh: () => exclusive(refresh),
    inspect: input => exclusive(() => inspect(input)),
    command: input => exclusive(() => command(input)),
    snapshot,
  };
}
import { modules, discoveryTool, validateToolInput } from './catalog.mjs';
import { createCreative } from './creative.mjs';
