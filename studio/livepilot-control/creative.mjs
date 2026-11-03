import { randomUUID } from 'node:crypto';

const stamp = () => new Date().toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const topology = session => JSON.stringify({
  id: session.session_instance_id, file: session.file_path,
  tracks: session.tracks.map(t => [t.index, t.name]),
  returns: session.return_tracks?.map(t => [t.index, t.name]), scenes: session.scene_count,
});
const safeTools = new Set([
  'set_tempo', 'create_midi_track', 'create_audio_track', 'set_track_name',
  'create_scene', 'set_scene_name', 'create_clip', 'set_clip_name', 'add_notes',
  'insert_device', 'set_device_parameter', 'load_sample_to_simpler',
  'set_track_volume', 'set_track_pan', 'set_track_send',
]);
function trackIndex(value) {
  if (!Number.isInteger(value) || value < -1000) throw new Error('Choose a valid track index.');
  return value;
}
function brief(input) {
  const result = {};
  for (const key of ['mood', 'texture', 'suggestion', 'preferences']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 2000)) {
      throw new Error(`${key} must be text of at most 2,000 characters.`);
    }
    result[key] = (input[key] || '').trim();
  }
  return result;
}
function allTracks(session) {
  return [...session.tracks, ...(session.return_tracks || []).map((t, i) => ({ ...t, index: -i - 1 })),
    { index: -1000, name: 'Master', master: true }];
}
export function buildTrackTree(tracks) {
  const nodes = new Map(tracks.map(track => [track.index, { track_index: track.index, children: [] }]));
  const byIndex = new Map(tracks.map(track => [track.index, track]));
  const parents = new Map();
  const warnings = [];
  for (const track of tracks) {
    if (track.index < 0 || (!track.is_grouped && track.group_track_index == null)) continue;
    const parent = byIndex.get(track.group_track_index);
    if (!Number.isInteger(track.group_track_index) || !track.is_grouped || !parent?.is_foldable ||
        parent.index < 0 || parent.index === track.index) {
      warnings.push(`${track.name}: group membership is unavailable or invalid. Showing this track separately. Update the Remote Script and call reload_handlers; if old handlers persist, save your Set and restart Live.`);
      continue;
    }
    parents.set(track.index, parent.index);
  }
  const cyclic = new Set();
  for (const track of tracks) {
    const path = new Set();
    let index = track.index;
    while (parents.has(index)) {
      if (path.has(index)) {
        for (const member of path) cyclic.add(member);
        break;
      }
      path.add(index);
      index = parents.get(index);
    }
  }
  for (const index of cyclic) {
    parents.delete(index);
    warnings.push(`${byIndex.get(index).name}: cyclic group membership. Showing this track separately; refresh the session.`);
  }
  const roots = [];
  for (const track of tracks) {
    const node = nodes.get(track.index);
    if (parents.has(track.index)) nodes.get(parents.get(track.index)).children.push(node);
    else roots.push(node);
  }
  return { roots, warnings, complete: warnings.length === 0 };
}
export function inferRole(name) {
  const roles = [
    ['kick', /kick|bd\b/i], ['bass', /bass|sub\b/i], ['percussion', /drum|snare|hat|tom|ride|crash|perc|tops/i],
    ['vocal', /vocal|vox|voice/i], ['pad', /pad|atmos|ambient|texture|drone/i],
    ['lead', /lead|synth|keys|piano|pluck|stab/i],
  ];
  return roles.find(([, pattern]) => pattern.test(name))?.[0] || 'unknown';
}
export function adviseTrack(track, intent, taste, measured) {
  const role = inferRole(track.name);
  const advice = [];
  let score = 0;
  const add = (priority, reason, action, basis) => {
    score = Math.max(score, priority);
    advice.push({ reason, action, basis });
  };
  if (track.meter?.is_playing && track.meter.level >= 0.99) {
    add(100, 'Output approaches full scale in the meter snapshot.',
      'Check headroom and transient gain before adding color.', 'Measured output peak; not a true-peak measurement.');
  }
  if (track.mute) add(15, 'Track is muted.', 'Decide whether this layer belongs before changing its sound.', 'Live track state.');
  if (/\b(dream|soft|calm|romantic|lush|sublime)/i.test(intent.mood) && ['pad', 'lead', 'vocal'].includes(role)) {
    add(65, 'This likely harmonic layer is a candidate for the requested softer mood.',
      'Inspect the source envelope and modulation first; audition slower articulation or a restrained filter movement.',
      'Creative hypothesis from your mood and the track name; not a measured emotional judgment.');
  }
  if (/\b(dark|tense|aggressive|energetic)/i.test(intent.mood) && ['bass', 'lead', 'percussion'].includes(role)) {
    add(65, 'This likely rhythmic or tonal layer can carry the requested energy.',
      'Audition instrument articulation and dynamics before adding effects.',
      'Creative hypothesis from your mood and the track name.');
  }
  if (intent.texture && !track.master && track.index >= 0 && !track.is_foldable) {
    add(role === 'pad' || role === 'vocal' ? 70 : 40,
      `Consider this layer for "${intent.texture}".`,
      'Read instrument parameters and audition one modulation or sample-processing change, then compare before/after.',
      'User texture request; track role inferred from name.');
  }
  const evidenceCount = Number(taste?.evidence_count || 0);
  if (intent.preferences || evidenceCount > 0) {
    const affinities = taste?.device_affinities || {};
    const matches = (track.devices || []).filter(d =>
      Object.keys(affinities).some(name => d.name.toLowerCase().includes(name.toLowerCase())));
    if (matches.length) add(60, `Taste graph references ${matches.map(d => d.name).join(', ')}.`,
      'Compare these devices with the current taste evidence before replacing the chain.',
      'Device affinity match; affinity sign/weight remains visible in Taste Graph.');
    else if (intent.preferences) add(30, 'Explicit taste preferences are available.',
      'Use Corpus and Technique Memory to find a fitting method; do not infer preference compliance from a fader.',
      'User preferences; no measured perceptual match yet.');
  }
  if (measured?.spectrum) add(35, `A ${measured.mode} spectrum is available.`,
    'Use the spectral balance below to choose a focused timbral adjustment.',
    measured.mode === 'offline source'
      ? 'Original source file; excludes clip warp, effects and downstream processing.'
      : 'Post-master measurement, including downstream processing and potentially returns; not a raw track stem.');
  if (!advice.length) add(10, role === 'unknown' ? 'Track role is not yet known.' : `Likely ${role} role.`,
    'Inspect devices and audio before choosing a creative change.', 'Name-based role hypothesis only.');
  return { track_index: track.index, track_name: track.name, role, role_source: 'name heuristic',
    priority: score, advice, measured: Boolean(measured?.spectrum) };
}
export function resolveBindings(value, results) {
  if (Array.isArray(value)) return value.map(v => resolveBindings(v, results));
  if (!value || typeof value !== 'object') return value;
  if ('$from_step' in value) {
    let result = results[value.$from_step];
    if (result === undefined) throw new Error(`Missing earlier result: ${value.$from_step}`);
    for (const key of (value.path || '').split('.').filter(Boolean)) {
      if (!result || !Object.hasOwn(result, key)) throw new Error(`Unresolved binding: ${value.path}`);
      result = result[key];
    }
    return result;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveBindings(v, results)]));
}

// Curated from creative-thinking.md; match exposed names, never invent plugin controls or units.
const knobDirections = [
  [/warmth|comfort|nostalgia|melancholy|sadness|darker|softer/i, /cutoff|filter.*freq|brightness/i, -1,
    'Try a slightly darker source by lowering its filter or brightness control.'],
  [/warmth|comfort|melancholy|sadness|soft attack/i, /^(?:amp |volume |a |env \d? ?)?attack$/i, 1,
    'Try a slower attack to soften the entrance of the sound.'],
  [/tension|anxiety|metal/i, /resonance|filter.*res\b/i, 1,
    'Try a little more resonance for a more pronounced ringing edge.'],
  [/euphoria|release|brighter/i, /cutoff|filter.*freq|brightness/i, 1,
    'Try opening the filter or brightness control for a brighter reveal.'],
  [/vastness|awe|euphoria|wider/i, /^(?:stereo |unison )?(?:width|spread)$/i, 1,
    'Try a little more stereo spread; check mono compatibility before keeping it.'],
  [/vastness|awe|melancholy/i, /^(?:reverb )?decay(?: time)?$/i, 1,
    'Try a longer existing decay for more sustained space.'],
  [/aggression|impact|fire|heat|warmer/i, /^(?:input )?drive$/i, 1,
    'Try a little more existing drive for harmonic character; watch output headroom.'],
  [/water|liquid/i, /^(?:chorus |lfo |mod(?:ulation)? )?depth$/i, 1,
    'If this modulation source is already routed, try more depth for liquid movement. Routing has not been verified.'],
  [/glass|crystalline/i, /diffusion/i, 1,
    'Try a little more existing diffusion for a denser reflective texture.'],
  [/breath|air/i, /noise (?:level|amount|volume)|^(?:noise)$/i, 1,
    'Try a small increase in the existing noise source for an airy component.'],
  [/fire|heat|granular|fragmented/i, /spray|grain.*random|flux/i, 1,
    'Try more grain dispersion or randomness in the existing grain process.'],
  [/electricity/i, /^(?:lfo |mod(?:ulation)? )rate$/i, 1,
    'Try a faster existing modulation rate for a more buzzing texture.'],
  [/organic|evolving|movement/i, /^(?:lfo|mod(?:ulation)?) (?:amount|depth)$/i, 1,
    'If this modulation source is already routed, try more depth for evolving timbre. Routing has not been verified.'],
];
export function suggestKnob(parameter, intent) {
  if (parameter.is_quantized) return null;
  const direction = [intent.mood, intent.texture, intent.suggestion].filter(Boolean).join(' / ');
  const rule = knobDirections.find(([goal, name]) => goal.test(direction) && name.test(parameter.name));
  if (!rule) return null;
  const target = Math.max(parameter.min, Math.min(parameter.max,
    parameter.value + rule[2] * (parameter.max - parameter.min) * 0.05));
  if (target === parameter.value) return null;
  return { value: target, reason: rule[3],
    basis: 'Creative hypothesis from the Markdown direction map and exposed parameter name. A 5% raw-range trial, not a calibrated Hz/ms value or a measured improvement.' };
}
function editableParameters(parameters, intent) {
  if (!Array.isArray(parameters)) throw new Error('No readable parameter list was returned.');
  return parameters.filter(p => Number.isInteger(p.index) && p.index >= 0 &&
    typeof p.name === 'string' && p.is_enabled !== false && p.is_read_only !== true &&
    [p.value, p.min, p.max].every(Number.isFinite) && p.min < p.max &&
    p.value >= p.min && p.value <= p.max &&
    (!p.is_quantized || [p.value, p.min, p.max].every(Number.isInteger)))
    .map(p => ({ ...p, suggestion: suggestKnob(p, intent) }));
}

export function createCreative(call, { sleep = wait } = {}) {
  let dashboard = null;
  let guidance = null;
  let focus = null;
  const reports = new Map();
  let plan = null;
  let intent = { mood: '', texture: '', suggestion: '', preferences: '' };
  let branches = null;
  const changes = [];
  const matches = (a, b, parameter) => Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= (parameter ? parameter.is_quantized ? 0 : (parameter.max - parameter.min) * 0.000001 : 0.0001);
  const deviceLayout = track => JSON.stringify(track.devices?.map(d => [d.index, d.name, d.class_name]));
  const settingTools = new Set(['set_device_parameter', 'set_tempo', 'set_track_volume', 'set_track_pan', 'set_track_send']);
  function publicChange(change) {
    const { args, expected, layout, parameter, key, ...visible } = change;
    return visible;
  }
  async function readSetting(tool, args) {
    if (tool === 'set_tempo') {
      const session = await call('get_session_info');
      return { value: session.tempo, display: `${session.tempo} BPM`, label: 'Tempo', track_name: 'Whole session' };
    }
    const track = await call('get_track_info', { track_index: args.track_index });
    const base = { track_name: track.name, layout: deviceLayout(track) };
    if (tool === 'set_device_parameter') {
      const result = await call('get_device_parameters', { track_index: args.track_index, device_index: args.device_index });
      const parameter = result.parameters?.find(p =>
        args.parameter_index !== undefined ? p.index === args.parameter_index : p.name === args.parameter_name);
      if (!parameter || parameter.is_enabled === false || parameter.is_read_only === true) throw new Error('Parameter is missing, disabled or read-only.');
      return { ...base, value: parameter.value, display: parameter.value_string ?? String(parameter.value),
        label: `${track.devices?.find(d => d.index === args.device_index)?.name || 'Device'} / ${parameter.name}`, parameter,
        parameters: result.parameters };
    }
    const send = tool === 'set_track_send' ? track.sends?.find(s => s.index === args.send_index) : null;
    const value = tool === 'set_track_volume' ? (track.mixer?.volume ?? track.volume) :
      tool === 'set_track_pan' ? (track.mixer?.panning ?? track.panning) : send?.value;
    return { ...base, value, display: String(value),
      label: tool === 'set_track_volume' ? 'Volume (raw 0-1)' :
        tool === 'set_track_pan' ? 'Pan (-1 left, +1 right)' : `${send?.name || 'Send'} (raw value)` };
  }
  function settingValue(tool, args) {
    return args[tool === 'set_tempo' ? 'tempo' : tool === 'set_track_volume' ? 'volume' :
      tool === 'set_track_pan' ? 'pan' : 'value'];
  }
  function settingArgs(change, value) {
    return { ...change.args, [change.tool === 'set_tempo' ? 'tempo' : change.tool === 'set_track_volume' ? 'volume' :
      change.tool === 'set_track_pan' ? 'pan' : 'value']: value };
  }
  async function optional(name, args, warnings) {
    try { return await call(name, args); }
    catch (error) { warnings.push(`${name}: ${error.message}`); return null; }
  }
  async function scan() {
    const session = await call('get_session_info');
    const warnings = [];
    const meters = await optional('get_track_meters', { include_stereo: true, samples: 3 }, warnings);
    const tracks = [];
    for (const item of allTracks(session)) {
      const info = await optional('get_track_info', { track_index: item.index }, warnings);
      tracks.push({ ...item, ...info, index: item.index,
        meter: { ...(meters?.tracks?.find(m => m.index === item.index) || {}),
          is_playing: meters?.is_playing ?? session.is_playing } });
    }
    const regular = tracks.filter(t => t.index >= 0);
    let isBlank = regular.every(t => Array.isArray(t.devices) && t.devices.length === 0 &&
      Array.isArray(t.clip_slots) && !t.clip_slots.some(slot => slot.has_clip));
    if (isBlank) {
      for (const track of regular) {
        const arrangement = await optional('get_arrangement_clips', { track_index: track.index }, warnings);
        if (!Array.isArray(arrangement?.clips) || arrangement.clips.length > 0) {
          isBlank = false;
          if (arrangement && !Array.isArray(arrangement.clips)) warnings.push('Could not verify arrangement contents; keeping Session Map first.');
          break;
        }
      }
    }
    const after = await call('get_session_info');
    if (topology(session) !== topology(after)) throw new Error('Track layout changed during scan. Refresh and retry.');
    if (dashboard && topology(dashboard.session) !== topology(session)) {
      reports.clear();
      guidance = null;
      plan = null;
      branches = null;
      focus = null;
    }
    dashboard = { session, tracks, is_blank: isBlank, warnings, timestamp: stamp() };
    return snapshot();
  }
  function snapshot() {
    const tree = dashboard ? buildTrackTree(dashboard.tracks) : null;
    return { dashboard: dashboard ? { ...dashboard, track_tree: tree.roots, grouping_complete: tree.complete,
      warnings: [...dashboard.warnings, ...tree.warnings] } : null,
      guidance, intent, branches, focus, reports: Object.fromEntries(reports), plan: publicPlan(),
      changes: changes.map(publicChange) };
  }
  async function ensureTrack(index) {
    if (!Number.isInteger(index)) throw new Error('Choose a valid track index.');
    trackIndex(index);
    if (!dashboard) await scan();
    const live = await call('get_session_info');
    if (topology(live) !== topology(dashboard.session)) throw new Error('Session topology changed. Refresh all tracks first.');
    const track = dashboard.tracks.find(t => t.index === index);
    if (!track) throw new Error('Track no longer exists.');
    return { track, session: live };
  }
  async function inspect(input) {
    const { track } = await ensureTrack(input.track_index);
    const warnings = [];
    const info = await call('get_track_info', { track_index: track.index });
    Object.assign(track, info, { index: track.index });
    const meter = await optional('get_track_meters', { track_index: track.index, include_stereo: true, samples: 3 }, warnings);
    const report = { track_index: track.index, name: track.name, timestamp: stamp(), mode: 'non-disruptive',
      scope: 'Device/clip state and LOM meters only. No per-track FFT or emotional inference.',
      info, meter, warnings, ...(reports.get(track.index)?.spectrum ? { previous_isolated: reports.get(track.index) } : {}) };
    reports.set(track.index, report);
    return { report, ...snapshot() };
  }
  async function offline(input) {
    const { track } = await ensureTrack(input.track_index);
    if (!Number.isInteger(input.clip_index) || input.clip_index < 0 ||
        !track.clip_slots?.some(c => c.index === input.clip_index && c.has_clip)) {
      throw new Error('Choose an occupied Session clip slot on this track.');
    }
    const location = await call('get_clip_file_path', { track_index: track.index, clip_index: input.clip_index });
    const file = location.file_path || location.path;
    if (typeof file !== 'string') throw new Error('This clip has no audio source file.');
    const spectrum = await call('analyze_spectrum_offline', { file_path: file });
    const loudness = await call('analyze_loudness', { file_path: file });
    const report = { track_index: track.index, name: track.name, timestamp: stamp(), mode: 'offline source',
      scope: 'Original audio source file, not warp, clip gain, instruments, effects, or the live track output.',
      file, spectrum, loudness, warnings: [] };
    reports.set(track.index, report);
    return { report, ...snapshot() };
  }
  async function analyzer(input) {
    if (input.confirmed !== true) throw new Error('Confirm loading the analyzer on master.');
    const result = await call('ensure_analyzer_on_master');
    if (!['loaded', 'already_loaded'].includes(result.status)) throw new Error(result.error || result.hint || result.status);
    if (!result.is_last_on_master) throw new Error('Move LivePilot_Analyzer to the end of master before analysis.');
    return { result, ...snapshot() };
  }
  async function streamTool(name, args) {
    try { return await call(name, args); }
    catch (error) {
      if (/unknown tool/i.test(error.message)) {
        throw new Error('Nothing was changed: the running LivePilot MCP server predates track analyzers. Restart the LivePilot MCP server, then retry.');
      }
      throw error;
    }
  }
  async function trackAnalyzer(input) {
    const { track } = await ensureTrack(input.track_index);
    if (track.index === -1000) throw new Error('Use Ensure master M4L analyzer for the master track.');
    if (input.confirmed !== true) throw new Error(`Confirm loading LivePilot_Analyzer on ${track.name}.`);
    const result = await streamTool('ensure_analyzer_on_track', { track_index: track.index });
    if (result.status === 'streams_unsupported') {
      throw new Error('Nothing was loaded: the analyzer build on master cannot keep track streams separate yet. ' +
        'Re-freeze LivePilot_Analyzer.amxd in Max from the current bridge JS, reload it on master, then retry.');
    }
    if (!['loaded', 'already_loaded'].includes(result.status)) throw new Error(result.error || result.hint || result.status);
    Object.assign(track, await call('get_track_info', { track_index: track.index }), { index: track.index });
    return { result, track_name: track.name, ...snapshot() };
  }
  async function trackStream(input) {
    const { track } = await ensureTrack(input.track_index);
    if (track.index === -1000) throw new Error('Use the master snapshot for the master track.');
    const spectrum = await streamTool('get_track_spectrum', { track_index: track.index, window_ms: 1000, samples: 10 });
    if (spectrum.status === 'streams_unsupported') throw new Error(spectrum.error);
    if (!spectrum.bands || spectrum.distinct_frames < 2) {
      throw new Error(spectrum.error || 'This track analyzer has no fresh distinct frames. Make sure the track is playing audio.');
    }
    const loudness = {};
    if (typeof spectrum.peak === 'number') loudness.peak = spectrum.peak;
    if (typeof spectrum.rms === 'number') loudness.rms = spectrum.rms;
    const report = { track_index: track.index, name: track.name, timestamp: stamp(), mode: 'track analyzer stream',
      scope: 'This track\'s own analyzer: its output after its devices, before group and master processing. No solo or playback change.',
      spectrum, loudness, warnings: [] };
    reports.set(track.index, report);
    return { report, ...snapshot() };
  }
  async function streamsSeparated() {
    try { return (await call('get_analyzer_streams')).streams_supported === true; }
    catch { return false; }
  }
  async function isolated(input) {
    if (input.confirmed !== true) throw new Error('Confirm the temporary solo change before isolated analysis.');
    const { track, session } = await ensureTrack(input.track_index);
    if (!session.is_playing) throw new Error('Start playback in Ableton first. Analysis never starts transport automatically.');
    if (session.record_mode || session.session_record) throw new Error('Stop recording before temporary isolation.');
    if (track.index !== -1000 && track.mute) throw new Error('This track is muted. Unmute it explicitly in Ableton before isolation.');
    if (dashboard.tracks.some(t => t.index !== -1000 && t.devices?.some(d => /LivePilot_Analyzer/i.test(d.name))) &&
      !await streamsSeparated()) {
      throw new Error('Remove track-local LivePilot analyzers: this analyzer build cannot keep their streams separate.');
    }
    const main = await call('get_track_info', { track_index: -1000 });
    const analyzers = main.devices?.filter(d => /LivePilot_Analyzer/i.test(d.name)) || [];
    if (analyzers.length !== 1 || main.devices.at(-1)?.name !== analyzers[0].name) {
      throw new Error('Exactly one LivePilot_Analyzer must be LAST on master. Use Ensure master analyzer first.');
    }
    const originals = allTracks(session).filter(t => t.index !== -1000);
    const changed = [];
    let data;
    let problem;
    const restoration = [];
    try {
      if (track.index !== -1000) {
        for (const item of originals) {
          if (item.solo) {
            changed.push(item);
            await call('set_track_solo', { track_index: item.index, solo: false });
          }
        }
        if (!changed.some(t => t.index === track.index)) changed.push(originals.find(t => t.index === track.index));
        await call('set_track_solo', { track_index: track.index, solo: true });
        const check = await call('get_session_info');
        if (!check.tracks.concat((check.return_tracks || []).map((t, i) => ({ ...t, index: -i - 1 })))
          .some(t => t.index === track.index && t.solo)) throw new Error('Ableton did not confirm the requested solo.');
      }
      await sleep(5500);
      const spectrum = await call('get_master_spectrum', { window_ms: 1000, samples: 10 });
      if (!spectrum.bands || spectrum.distinct_frames < 2) throw new Error('Analyzer has no fresh distinct spectral frames. Check the bridge before retrying.');
      if (spectrum.detected_key) {
        spectrum.mix_wide_key_history = spectrum.detected_key;
        delete spectrum.detected_key;
      }
      const loudness = await call('get_master_rms');
      data = { track_index: track.index, name: track.name, timestamp: stamp(),
        mode: track.index === -1000 ? 'master mix' : 'isolated through master',
        scope: track.index === -1000 ? 'Full mix on master.' :
          'Soloed track through downstream groups, master effects, and potentially sends/returns. Not a pre-master stem.',
        spectrum, loudness, warnings: ['Key is not attributed to this track: the detector accumulates session-wide pitch history.'] };
    } catch (error) { problem = error; }
    finally {
      const current = await call('get_session_info').catch(error => {
        restoration.push(`Cannot verify session before restoring: ${error.message}`);
        return null;
      });
      if (current && topology(current) === topology(session)) {
        // Clear our temporary solo first; then restore pre-existing solos.
        const restore = [...changed].sort((a, b) => Number(a.solo) - Number(b.solo));
        for (const item of restore) {
          try { await call('set_track_solo', { track_index: item.index, solo: Boolean(item.solo) }); }
          catch (error) { restoration.push(`Restore ${item.name}: ${error.message}`); }
        }
        try {
          const verified = await call('get_session_info');
          const actual = allTracks(verified);
          for (const item of originals) {
            if (Boolean(actual.find(t => t.index === item.index)?.solo) !== Boolean(item.solo)) {
              restoration.push(`Solo state not restored for ${item.name}.`);
            }
          }
        } catch (error) { restoration.push(`Restore verification: ${error.message}`); }
      } else if (changed.length) restoration.push('Session topology changed; automatic solo restoration refused to avoid altering different tracks.');
    }
    if (restoration.length) throw new Error(`SOLO RESTORATION REQUIRES ATTENTION: ${restoration.join(' ')}${problem ? ` Analysis: ${problem.message}` : ''}`);
    if (problem) throw problem;
    reports.set(track.index, data);
    return { report: data, ...snapshot() };
  }
  async function knowledge(input) {
    intent = brief(input);
    const selection = input.track_index === undefined ? null : (await ensureTrack(input.track_index)).track;
    if (!dashboard) await scan();
    const warnings = [];
    const target = selection ? `Track ${selection.index} "${selection.name}", devices: ${(selection.devices || []).map(d => d.name).join(', ')}.` :
      `All ${dashboard.session.track_count} tracks.`;
    const query = [intent.mood, intent.texture, intent.suggestion, intent.preferences].filter(Boolean).join(' / ') || 'production techniques';
    const taste = await optional('get_taste_graph', {}, warnings);
    const memory = await optional('memory_recall', { query, limit: 8 }, warnings);
    const corpus = await optional('consult_ableton_knowledge', {
      question: `${target} Suggest instrument-first techniques for mood, texture and taste: ${query}. Distinguish evidence from hypotheses.`,
      session_context: { tracks: (selection ? [selection] : dashboard.tracks).map(t => ({
        index: t.index, name: t.name, devices: t.devices?.map(d => d.name),
      })) },
    }, warnings);
    const ranked = dashboard.tracks.map(track =>
      adviseTrack(track, intent, taste, reports.get(track.index))).sort((a, b) => b.priority - a.priority);
    guidance = { scope: selection ? `track ${selection.index}` : 'all tracks', track_index: selection?.index,
      intent, taste, memory, corpus, ranked, warnings, timestamp: stamp(),
      notice: 'Advice is a transparent role-based hypothesis, not a measured mood score. Corpus returns a consultation plan, not completed research. Taste is global; recommendations are evaluated per track.' };
    return snapshot();
  }
  async function focusSuggestions(input) {
    const nextIntent = brief(input);
    if (!Object.values(nextIntent).some(Boolean)) throw new Error('Choose a creative direction or enter your own suggestion first.');
    if (!['song', 'tracks'].includes(input.scope)) throw new Error('Choose selected tracks or the whole song first.');
    if (!dashboard) await scan();
    const session = await call('get_session_info');
    if (topology(session) !== topology(dashboard.session)) throw new Error('Session changed. Refresh the Session Map first.');
    if (input.scope === 'tracks' && (!Array.isArray(input.track_indices) || !input.track_indices.length ||
        input.track_indices.some(index => !Number.isInteger(index) || !dashboard.tracks.some(t => t.index === index)))) {
      throw new Error('Choose at least one current track.');
    }
    const selected = input.scope === 'song' ? dashboard.tracks :
      dashboard.tracks.filter(t => input.track_indices.includes(t.index));
    const deviceFilter = Number.isInteger(input.device_index) && Number.isInteger(input.track_index) ? input.device_index : null;
    if (deviceFilter !== null && !dashboard.tracks.find(t => t.index === input.track_index)?.devices?.some(d => d.index === deviceFilter)) {
      throw new Error('The chosen instrument is no longer on this track. Refresh the track context.');
    }
    const warnings = [];
    const tracks = [];
    for (const track of selected) {
      const info = await call('get_track_info', { track_index: track.index });
      if (deviceLayout(info) !== deviceLayout(track)) throw new Error(`${track.name}: devices changed. Refresh the Session Map first.`);
      const devices = [];
      for (const device of info.devices || []) {
        if (device.name === 'LivePilot_Analyzer') continue;
        if (deviceFilter !== null && track.index === input.track_index && device.index !== deviceFilter) continue;
        const result = await optional('get_device_parameters', { track_index: track.index, device_index: device.index }, warnings);
        if (!result) continue;
        if (!Array.isArray(result.parameters)) {
          warnings.push(`${track.name} / ${device.name}: no readable parameter list was returned.`);
          continue;
        }
        const parameters = editableParameters(result.parameters, nextIntent);
        if (parameters.length) devices.push({ index: device.index, name: device.name, class_name: device.class_name, parameters });
      }
      tracks.push({ index: track.index, name: track.name, layout: deviceLayout(info), devices,
        advice: adviseTrack({ ...track, ...info }, nextIntent, null, reports.get(track.index)) });
    }
    const after = await call('get_session_info');
    if (topology(after) !== topology(session)) throw new Error('Session changed while reading knobs. Refresh and retry.');
    intent = nextIntent;
    focus = { id: randomUUID(), expected: topology(session), scope: input.scope, intent: nextIntent,
      tracks, warnings, timestamp: stamp(),
      notice: 'Proposals only. Select an idea, adjust its target, then Apply this knob. Whole song means suggestions across tracks, returns and master, not a batch edit. Only top-level devices and exposed rack macros/plugin parameters are available; no hidden plugin knobs are invented.' };
    return snapshot();
  }
  function updateFocus(change, actual) {
    const parameter = focus?.tracks.find(t => t.index === change.args.track_index)?.devices
      .find(d => d.index === change.args.device_index)?.parameters.find(p => p.index === actual.parameter?.index);
    if (parameter) Object.assign(parameter, actual.parameter, { change_id: change.id });
  }
  async function applyFocus(input) {
    if (!focus || input.focus_id !== focus.id) throw new Error('Suggestions changed. Read the current suggestions first.');
    if (input.confirmed !== true) throw new Error('Approve this knob change explicitly.');
    const track = focus.tracks.find(t => t.index === input.track_index);
    const device = track?.devices.find(d => d.index === input.device_index);
    const parameter = device?.parameters.find(p => p.index === input.parameter_index);
    if (!parameter || input.reviewed_value !== parameter.value) throw new Error('Knob review is stale. Refresh suggestions before applying.');
    if (!Number.isFinite(input.value) || input.value < parameter.min || input.value > parameter.max ||
        (parameter.is_quantized && !Number.isInteger(input.value))) throw new Error('Choose a value inside this knob range.');
    if (input.value === parameter.value) throw new Error('Choose a different target value; this knob is already at that setting.');
    if (changes.some(c => c.id === parameter.change_id && c.state === 'uncertain')) {
      throw new Error('This knob has an uncertain write. Inspect Ableton and refresh suggestions before continuing.');
    }
    const current = await call('get_track_info', { track_index: track.index });
    if (deviceLayout(current) !== track.layout) throw new Error('Device layout changed. Refresh suggestions first.');
    const args = { track_index: track.index, device_index: device.index, parameter_index: parameter.index, value: input.value };
    const knobPlan = { id: randomUUID(), kind: 'track', intent: focus.intent, expected: focus.expected,
      next: 0, status: 'review', bindings: {}, sceneMap: {}, trackMap: { [track.index]: track.index },
      guards: { track_index: track.index, device_index: device.index, device_name: device.name,
        class_name: device.class_name, parameters: [parameter] },
      steps: [{ index: 0, tool: 'set_device_parameter', params: args, state: 'pending' }] };
    try { await execute({ plan_id: knobPlan.id, step_index: 0, confirmed: true }, knobPlan); }
    finally {
      const change = changes.find(c => c.plan_id === knobPlan.id);
      if (change) parameter.change_id = change.id;
    }
    return snapshot();
  }
  async function design(input) {
    const { track } = await ensureTrack(input.track_index);
    const result = await call('plan_sound_design_move', { track_index: track.index });
    return { track_index: track.index, result,
      notice: 'Device-state critic suggestions. Shared master sonic snapshots are not isolated track measurements.' };
  }
  function publicPlan() {
    if (!plan) return null;
    const { bindings, trackMap, sceneMap, expected, guards, ...visible } = plan;
    return visible;
  }
  async function compose(input) {
    if (!dashboard) await scan();
    intent = brief(input);
    if (!Object.values(intent).some(Boolean)) throw new Error('Choose a mood or texture, or enter your own suggestion or taste preference.');
    const scope = input.track_index === undefined ? 'all tracks' : (await ensureTrack(input.track_index)).track.name;
    const live = await call('get_session_info');
    if (topology(live) !== topology(dashboard.session)) throw new Error('Refresh the session map before planning.');
    const prompt = `At ${live.tempo} BPM, develop ${scope}. Mood: ${intent.mood}. Texture: ${intent.texture}. Your own suggestion: ${intent.suggestion}. Preferences: ${intent.preferences}.`;
    const result = await call('get_composition_plan', { prompt });
    if (!Array.isArray(result.plan)) throw new Error('Composer did not return executable plan steps.');
    const needsSources = result.layers?.length > 0 && !result.plan.some(step => ['create_midi_track', 'create_audio_track'].includes(step.tool));
    plan = { id: randomUUID(), timestamp: stamp(), prompt, source: result, next: 0,
      expected: topology(live), bindings: {}, trackMap: {}, sceneMap: {}, kind: 'composer',
      scope, intent, status: needsSources ? 'needs_sources' : result.plan.length ? 'review' : 'complete',
      notice: needsSources
        ? 'Composer could not resolve samples for any layer. This preview is NOT a complete musical plan; tempo-only execution is blocked. Configure local sample sources in LivePilot and regenerate, or use an existing-track instrument branch. See the source warnings below.'
        : 'Composer generates NEW layers, not a safe automatic rewrite of existing tracks. Creation is redirected to append-only tracks; subsequent steps bind to those new tracks. Existing-track changes require separate device-level review.',
      steps: result.plan.map((step, index) => ({
        ...step, index, state: 'pending',
        blocked: needsSources ? 'Resolve samples and regenerate before execution.' :
          !safeTools.has(step.tool) ? `Tool ${step.tool} is not enabled for step execution.` : null,
      })) };
    return snapshot();
  }
  async function trackPlan(input) {
    const { track, session } = await ensureTrack(input.track_index);
    const all = input.device_index === 'all';
    const controlsOnly = input.controls_only === true;
    if (!all && (!Number.isInteger(input.device_index) || !track.devices?.some(d => d.index === input.device_index))) {
      throw new Error('Choose all instruments or a device from this track.');
    }
    const target = {};
    for (const key of ['brightness', 'warmth', 'movement', 'softness', 'width', 'texture_density']) {
      if (input.target?.[key] === undefined) continue;
      const value = input.target[key];
      if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error(`${key} must be between -1 and 1.`);
      target[key] = value;
    }
    if (!controlsOnly) intent = brief(input);
    const controlIntent = { mood: '', texture: '', suggestion: '' };
    const info = await call('get_track_info', { track_index: track.index });
    if (deviceLayout(info) !== deviceLayout(track)) throw new Error('Device layout changed. Refresh the track context.');
    const chosen = all ? (info.devices || []).filter(d => d.name !== 'LivePilot_Analyzer') :
      [info.devices?.find(d => d.index === input.device_index)].filter(Boolean);
    if (!chosen.length) throw new Error(all ? 'This track has no instruments or plug-ins to develop.' : 'Device layout changed.');
    const compiledPlans = [];
    const warnings = [];
    const parameterStates = {};
    const controls = [];
    for (const device of chosen) {
      const params = await call('get_device_parameters', { track_index: track.index, device_index: device.index });
      const parameters = editableParameters(params.parameters, controlIntent);
      controls.push({ index: device.index, name: device.name, class_name: device.class_name, parameters });
      if (!parameters.length) warnings.push(`${device.name}: no editable controls are exposed to Ableton. For VST/AU devices, use Configure in Live to expose controls, then refresh.`);
      if (controlsOnly) continue;
      let result;
      try {
        result = await call('propose_synth_branches', {
          track_index: track.index, device_index: device.index, target,
          role_hint: inferRole(track.name) === 'unknown' ? '' : inferRole(track.name), freshness: 0.5,
        });
      } catch (error) {
        if (!/is not a supported native synth/.test(error.message)) throw error;
        warnings.push(`${device.name}: using exposed device controls instead of native-synth branches.`);
        continue;
      }
      for (const warning of result.warnings || []) {
        warnings.push(/is not a supported native synth/.test(warning) ?
          `${device.name}: using exposed device controls instead of native-synth branches.` :
          `${device.name}: ${warning}`);
      }
      if (!result.compiled_plans?.length) continue;
      parameterStates[device.index] = params.parameters;
      result.compiled_plans.forEach((compiled, index) => compiledPlans.push({ ...compiled,
        summary: compiled.summary || result.seeds?.[index]?.label,
        device_index: device.index, device_name: device.name, class_name: device.class_name }));
    }
    const after = await call('get_session_info');
    const current = await call('get_track_info', { track_index: track.index });
    if (topology(after) !== topology(session) || deviceLayout(current) !== deviceLayout(info)) {
      throw new Error('Session or devices changed while reading controls. Refresh and retry.');
    }
    focus = { id: randomUUID(), expected: topology(session), scope: 'tracks', intent,
      tracks: [{ index: track.index, name: track.name, layout: deviceLayout(info), devices: controls,
        advice: adviseTrack(track, intent, null, reports.get(track.index)) }],
      warnings, timestamp: stamp(),
      notice: controlsOnly
        ? 'Actual exposed controls read from Ableton. No plugin settings or target values were generated. Adjust a real exposed control, then approve each knob change.'
        : 'Actual exposed controls, not invented plugin settings. Adjust a real exposed control, then approve each knob change. Relative timbre targets apply only to native-synth branches.' };
    branches = { id: randomUUID(), track_index: track.index, device_index: all ? 'all' : chosen[0].index,
      track_name: track.name, device_name: all ? 'All instruments and plug-ins' : chosen[0].name, class_name: all ? null : chosen[0].class_name,
      parameter_states: parameterStates, focus_id: focus.id,
      result: { compiled_plans: compiledPlans, warnings }, target, timestamp: stamp() };
    return snapshot();
  }
  async function chooseBranch(input) {
    if (!branches || input.branch_id !== branches.id || !Number.isInteger(input.branch_index)) throw new Error('Track branches changed. Refresh and review the current proposals.');
    const compiled = branches.result.compiled_plans[input.branch_index];
    if (!Array.isArray(compiled?.steps) || !compiled.steps.length) throw new Error('Selected branch has no executable steps.');
    const { track, session } = await ensureTrack(branches.track_index);
    const info = await call('get_track_info', { track_index: track.index });
    const device = info.devices?.find(d => d.index === compiled.device_index);
    if (!device || device.name !== compiled.device_name || device.class_name !== compiled.class_name) throw new Error('Device layout changed.');
    const params = await call('get_device_parameters', { track_index: track.index, device_index: device.index });
    if (JSON.stringify(params.parameters) !== JSON.stringify(branches.parameter_states[device.index])) throw new Error('Instrument changed since proposals. Generate fresh branches.');
    plan = { id: randomUUID(), timestamp: stamp(), kind: 'track', scope: track.name, intent,
      source: compiled, next: 0, expected: topology(session), bindings: {}, sceneMap: {},
      trackMap: { [track.index]: track.index }, status: 'review',
      guards: { track_index: track.index, device_index: device.index, device_name: device.name,
        class_name: device.class_name, parameters: params.parameters },
      notice: `Existing-track instrument plan for ${track.name}. Targets are user-specified relative timbral directions, not measured mood guarantees. Approve each parameter change, then analyze and listen.`,
      steps: compiled.steps.map((step, index) => ({ ...step, index, state: 'pending',
        blocked: step.tool !== 'set_device_parameter' ||
          step.params?.track_index !== track.index || step.params?.device_index !== device.index
          ? 'Only parameter changes to the chosen instrument are enabled in this track plan.' : null })),
    };
    return snapshot();
  }
  async function execute(input, executionPlan = plan) {
    const plan = executionPlan;
    if (!plan || input.plan_id !== plan.id) throw new Error('Plan is missing or has changed. Generate and review it again.');
    if (input.confirmed !== true || input.step_index !== plan.next) throw new Error('Approve the next step explicitly and in order.');
    if (plan.status === 'uncertain') throw new Error('A previous step failed after dispatch. Inspect Ableton and generate a new plan; automatic retry is disabled.');
    if (plan.status === 'reverted') throw new Error('This plan was reverted. Generate a fresh plan.');
    if (changes.some(c => c.plan_id === plan.id && ['bypassed', 'uncertain'].includes(c.state))) {
      throw new Error('Re-enable bypassed settings before continuing this plan. Uncertain changes require inspection.');
    }
    const step = plan.steps[plan.next];
    if (!step || step.blocked) throw new Error(step?.blocked || 'Plan is complete.');
    const live = await call('get_session_info');
    if (topology(live) !== plan.expected) throw new Error('Session layout changed outside this plan. Generate a fresh plan.');
    const rawArgs = step.params || step.arguments || {};
    const args = resolveBindings(rawArgs, plan.bindings);
    if (/<[^<>]+>|\bTODO\b/.test(JSON.stringify(args))) throw new Error('Composer step contains an unresolved placeholder.');
    const creating = ['create_midi_track', 'create_audio_track'].includes(step.tool);
    const creatingScene = step.tool === 'create_scene';
    if (creating) args.index = -1;
    else if ('track_index' in args) {
      if (!(rawArgs.track_index?.$from_step && Object.values(plan.trackMap).includes(args.track_index))) {
        if (!Object.hasOwn(plan.trackMap, args.track_index)) throw new Error('Step targets an existing or unresolved track. Refusing to overwrite your session.');
        args.track_index = plan.trackMap[args.track_index];
      }
    }
    if (creatingScene) args.index = -1;
    if ('scene_index' in args) {
      if (!(rawArgs.scene_index?.$from_step && Object.values(plan.sceneMap).includes(args.scene_index))) {
        if (!Object.hasOwn(plan.sceneMap, args.scene_index)) throw new Error('Step targets an existing or unresolved scene.');
        args.scene_index = plan.sceneMap[args.scene_index];
      }
    }
    if (Number.isInteger(args.track_index) && !creating) {
      const previous = dashboard.tracks.find(t => t.index === args.track_index);
      if (previous?.devices) {
        const current = await call('get_track_info', { track_index: args.track_index });
        const layout = devices => devices?.map(d => [d.index, d.name, d.class_name]);
        if (JSON.stringify(layout(current.devices)) !== JSON.stringify(layout(previous.devices))) {
          throw new Error('Device layout changed outside this plan. Refresh and generate a new plan.');
        }
      }
    }
    if (plan.kind === 'track') {
      const current = await call('get_track_info', { track_index: plan.guards.track_index });
      const device = current.devices?.find(d => d.index === plan.guards.device_index);
      if (device?.name !== plan.guards.device_name || device?.class_name !== plan.guards.class_name) {
        throw new Error('Instrument changed after planning. Generate a fresh branch.');
      }
    }
    const before = settingTools.has(step.tool) ? await readSetting(step.tool, args) : null;
    if (before && !Number.isFinite(before.value)) throw new Error('Could not read the original setting; refusing an untracked change.');
    let parameterIndex;
    if (step.tool === 'set_device_parameter') {
      const parameter = before.parameter;
      if (!parameter || parameter.is_enabled === false || !Number.isFinite(parameter.min) ||
          !Number.isFinite(parameter.max) || !Number.isFinite(args.value) ||
          args.value < parameter.min || args.value > parameter.max ||
          (parameter.is_quantized && !Number.isInteger(args.value))) {
        throw new Error('Parameter is missing or outside its freshly read range.');
      }
      parameterIndex = parameter.index;
      if (plan.kind === 'track') {
        const previous = plan.guards.parameters.find(p => p.index === parameter.index && p.name === parameter.name);
        if (!previous || previous.min !== parameter.min || previous.max !== parameter.max ||
            Boolean(previous.is_quantized) !== Boolean(parameter.is_quantized) ||
            !matches(previous.value, parameter.value, parameter)) {
          throw new Error('Parameter changed since branch review. Generate a fresh branch.');
        }
      }
    }
    const change = before ? {
      id: randomUUID(), plan_id: plan.id, step_index: step.index, tool: step.tool,
      args: { ...args, ...(parameterIndex === undefined ? {} : { parameter_index: parameterIndex }) },
      expected: topology(live), layout: before.layout, parameter: before.parameter,
      key: JSON.stringify([step.tool, args.track_index, args.device_index, parameterIndex, args.send_index]),
      track_name: before.track_name, label: before.label, before: before.value,
      before_display: before.display, after: settingValue(step.tool, args),
      state: 'uncertain', timestamp: stamp(),
    } : null;
    if (change) changes.push(change);
    step.state = 'executing';
    try {
      const result = await call(step.tool, args);
      step.result = result;
      if (change) {
        const actual = await readSetting(step.tool, change.args);
        if (!matches(actual.value, change.after, actual.parameter)) throw new Error('Setting readback does not match the requested value.');
        step.verified_value = actual.display;
        change.after_display = actual.display;
        updateFocus(change, actual);
        if (plan.kind === 'track') plan.guards.parameters = plan.guards.parameters.map(p =>
          p.index === actual.parameter.index ? actual.parameter : p);
      }
      const updated = await call('get_session_info');
      if (creating) {
        const created = updated.tracks.filter(t => !live.tracks.some(old => old.index === t.index));
        if (created.length !== 1) throw new Error('Could not unambiguously identify the newly appended track.');
        plan.trackMap[step.params?.index] = created[0].index;
        if (step.step_id) plan.bindings[step.step_id] = { ...result, track_index: created[0].index, index: created[0].index };
      } else if (step.step_id) plan.bindings[step.step_id] = result;
      if (creatingScene) {
        if (updated.scene_count !== live.scene_count + 1) throw new Error('Could not verify newly appended scene.');
        plan.sceneMap[step.params?.index] = live.scene_count;
      }
      plan.expected = topology(updated);
      for (const previous of changes.filter(c => c.plan_id === plan.id)) previous.expected = plan.expected;
      dashboard.session = updated;
      dashboard.tracks = allTracks(updated).map(t => ({
        ...dashboard.tracks.find(old => old.index === t.index), ...t,
      }));
      if (Number.isInteger(args.track_index)) {
        const info = await call('get_track_info', { track_index: args.track_index });
        const changed = dashboard.tracks.find(t => t.index === args.track_index);
        if (changed) Object.assign(changed, info, { index: args.track_index });
        reports.delete(args.track_index);
      }
      dashboard.timestamp = stamp();
      if (step.tool !== 'set_tempo') dashboard.is_blank = false;
      guidance = null;
      step.applied_arguments = args;
      step.state = 'done';
      if (change) {
        change.state = 'active';
        step.change_id = change.id;
      }
      plan.next++;
      plan.status = plan.next === plan.steps.length ? 'complete' : 'review';
    } catch (error) {
      step.state = 'uncertain';
      step.error = error.message;
      plan.status = 'uncertain';
      throw new Error(`Step may have partially applied. Do not retry blindly: ${error.message}`);
    }
    return snapshot();
  }
  async function recover(input) {
    const change = changes.find(c => c.id === input.change_id);
    if (!change || input.confirmed !== true) throw new Error('Confirm a saved change before bypassing or reverting it.');
    if (!['bypass', 'enable', 'revert'].includes(input.mode)) throw new Error('Choose bypass, enable, or revert.');
    if (['uncertain', 'reverted'].includes(change.state)) throw new Error('This change cannot be toggled. Inspect Ableton before making a fresh plan.');
    if (input.mode === 'enable' ? change.state !== 'bypassed' : input.mode === 'bypass' && change.state !== 'active') {
      throw new Error('Change state has changed. Refresh before retrying.');
    }
    const later = changes.slice(changes.indexOf(change) + 1).some(c => c.key === change.key && c.state !== 'reverted');
    if (later) throw new Error('A newer change affects this setting. Revert newer changes first.');
    const live = await call('get_session_info');
    if (topology(live) !== change.expected) throw new Error('Session layout changed. Refusing to restore a potentially different track.');
    const current = await readSetting(change.tool, change.args);
    if (current.layout !== change.layout || current.track_name !== change.track_name ||
        (change.parameter && (current.parameter?.name !== change.parameter.name ||
          current.parameter?.min !== change.parameter.min || current.parameter?.max !== change.parameter.max))) {
      throw new Error('Device or parameter layout changed. Refusing to restore a different setting.');
    }
    const expectedValue = change.state === 'active' ? change.after : change.before;
    if (!matches(current.value, expectedValue, current.parameter)) throw new Error('Setting was changed elsewhere. Refusing to overwrite your newer edit.');
    const target = input.mode === 'enable' ? change.after : change.before;
    try {
      if (input.mode !== 'revert' || change.state !== 'bypassed') {
        await call(change.tool, settingArgs(change, target));
      }
      const actual = await readSetting(change.tool, change.args);
      if (!matches(actual.value, target, actual.parameter)) throw new Error('Restored setting readback does not match.');
      change.state = input.mode === 'enable' ? 'active' : input.mode === 'bypass' ? 'bypassed' : 'reverted';
      change.current_display = actual.display;
      updateFocus(change, actual);
      if (plan?.id === change.plan_id) {
        if (plan.kind === 'track') plan.guards.parameters = plan.guards.parameters.map(p =>
          p.index === actual.parameter.index ? actual.parameter : p);
        if (input.mode === 'revert') plan.status = 'reverted';
      }
      if (change.args.track_index !== undefined) {
        reports.delete(change.args.track_index);
        const info = await call('get_track_info', { track_index: change.args.track_index });
        const track = dashboard?.tracks.find(t => t.index === change.args.track_index);
        if (track) Object.assign(track, info);
      } else if (dashboard) dashboard.session.tempo = actual.value;
      guidance = null;
      if (dashboard) dashboard.timestamp = stamp();
    } catch (error) {
      change.state = 'uncertain';
      change.error = error.message;
      throw new Error(`Recovery may have partially applied. Inspect Ableton; automatic retry is disabled: ${error.message}`);
    }
    return snapshot();
  }
  async function transport(input) {
    if (!['start', 'stop', 'loop'].includes(input.command)) throw new Error('Choose Start, Stop, or Loop.');
    const live = await call('get_session_info');
    let loop;
    if (input.command === 'loop') {
      if (typeof input.enabled !== 'boolean') throw new Error('Loop enabled must be true or false.');
      loop = { enabled: input.enabled };
      if (input.start_bar !== undefined || input.end_bar !== undefined) {
        const { signature_numerator: numerator, signature_denominator: denominator } = live;
        if (!Number.isInteger(numerator) || numerator <= 0 || !Number.isInteger(denominator) || denominator <= 0) {
          throw new Error('Live time signature is unavailable; cannot safely convert bars to beats.');
        }
        if (!Number.isFinite(input.start_bar) || !Number.isFinite(input.end_bar) ||
            input.start_bar < 1 || input.end_bar <= input.start_bar) {
          throw new Error('Start bar must be at least 1, and end bar must be later than start (exclusive).');
        }
        const beatsPerBar = numerator * 4 / denominator;
        loop.start = (input.start_bar - 1) * beatsPerBar;
        loop.length = (input.end_bar - input.start_bar) * beatsPerBar;
      }
      await call('set_session_loop', loop);
    } else await call(input.command === 'start' ? 'start_playback' : 'stop_playback');
    const actual = await call('get_session_info');
    if (topology(actual) !== topology(live)) throw new Error('Session changed during transport control. Refresh and inspect Ableton.');
    if (loop ? actual.loop !== loop.enabled ||
        (loop.start !== undefined && (!matches(actual.loop_start, loop.start) || !matches(actual.loop_length, loop.length))) :
      actual.is_playing !== (input.command === 'start')) {
      throw new Error('Transport readback does not match the request. Check Ableton before retrying.');
    }
    if (!dashboard) await scan();
    else {
      dashboard.session = actual;
      dashboard.timestamp = stamp();
    }
    return snapshot();
  }
  async function run(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected creative action input.');
    const actions = { scan, inspect, offline, analyzer, trackAnalyzer, trackStream, isolated, knowledge, focus: focusSuggestions, applyFocus,
      design, compose, trackPlan, chooseBranch, execute, recover, transport,
      direction: () => { intent = brief(input); return snapshot(); } };
    if (!Object.hasOwn(actions, input.action)) throw new Error('Unknown creative action.');
    return actions[input.action](input);
  }
  return { run, snapshot };
}
