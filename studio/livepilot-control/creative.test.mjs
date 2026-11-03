import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreative, adviseTrack, resolveBindings, buildTrackTree, suggestKnob } from './creative.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function fixture() {
  const calls = [];
  const state = {
    session_instance_id: 'one', file_path: '/test.als', tempo: 123, is_playing: true,
    scene_count: 2, scenes: [], return_tracks: [],
    signature_numerator: 4, signature_denominator: 4, loop: false, loop_start: 0, loop_length: 16,
    tracks: [{ index: 0, name: 'Pad', solo: false, mute: false },
      { index: 1, name: 'Kick', solo: true, mute: false }],
  };
  let value = 0.3;
  let failSpectrum = false;
  let failWrite = false;
  let failRestore = false;
  let ignoreWrites = false;
  const analyzerStreams = { supported: false };
  const composer = [
    { step_id: 'new-track', tool: 'create_midi_track', params: { index: 0 }, description: 'Create layer' },
    { tool: 'set_track_name', params: { track_index: 0, name: 'New Layer' } },
    { tool: 'create_scene', params: { index: 0 } },
    { tool: 'set_scene_name', params: { scene_index: 0, name: 'New Section' } },
  ];
  const devices = [{ index: 0, name: 'Wavetable', class_name: 'InstrumentVector' }];
  const composerResult = {};
  const parameterOverrides = {};
  const synthFailures = new Map();
  const synthWarnings = new Map();
  const parameterFailures = new Map();
  const call = async (name, args = {}) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'get_session_info') return structuredClone({ ...state, track_count: state.tracks.length });
    if (name === 'get_track_info') {
      if (args.track_index === -1000) return { name: 'Master', devices: [{ index: 0, name: 'LivePilot_Analyzer' }] };
      return structuredClone({ mixer: { volume: 0.8, panning: 0 }, sends: [{ index: 0, name: 'A', value: 0 }],
        ...state.tracks.find(t => t.index === args.track_index), devices,
        clip_slots: [{ index: 0, has_clip: true }] });
    }
    if (name === 'start_playback' || name === 'stop_playback') {
      state.is_playing = name === 'start_playback';
      return { is_playing: state.is_playing };
    }
    if (name === 'set_session_loop') {
      state.loop = args.enabled;
      if (args.start !== undefined) state.loop_start = args.start;
      if (args.length !== undefined) state.loop_length = args.length;
      return { loop: state.loop, loop_start: state.loop_start, loop_length: state.loop_length };
    }
    if (name === 'set_tempo') { state.tempo = args.tempo; return { tempo: state.tempo }; }
    if (['set_track_volume', 'set_track_pan', 'set_track_send'].includes(name)) {
      const track = state.tracks.find(t => t.index === args.track_index);
      track.mixer ??= { volume: 0.8, panning: 0 };
      track.sends ??= [{ index: 0, name: 'A', value: 0 }];
      if (name === 'set_track_volume') track.mixer.volume = args.volume;
      else if (name === 'set_track_pan') track.mixer.panning = args.pan;
      else track.sends[args.send_index].value = args.value;
      return { ok: true };
    }
    if (name === 'get_track_meters') return { is_playing: state.is_playing, tracks: state.tracks.map(t => ({ index: t.index, level: t.index ? 0.999 : 0.3 })) };
    if (name === 'set_track_solo') {
      if (failRestore && args.track_index === 1 && args.solo) throw new Error('Restore blocked');
      state.tracks.find(t => t.index === args.track_index).solo = args.solo;
      return { solo: args.solo };
    }
    if (name === 'get_master_spectrum') {
      if (failSpectrum) throw new Error('Analyzer offline');
      return { bands: { sub: 0.2, mid: 0.7 }, distinct_frames: 10, detected_key: { key: 'C' } };
    }
    if (name === 'get_master_rms') return { rms: 0.2, peak: 0.5 };
    if (name === 'get_analyzer_streams') return { streams_supported: analyzerStreams.supported, streams: [] };
    if (name === 'ensure_analyzer_on_track') {
      if (!analyzerStreams.supported) return { status: 'streams_unsupported', error: 'no streams' };
      if (devices.some(d => d.name === 'LivePilot_Analyzer')) return { status: 'already_loaded', is_last_on_track: true };
      devices.push({ index: devices.length, name: 'LivePilot_Analyzer' });
      return { status: 'loaded', device_index: devices.length - 1, is_last_on_track: true, stream: `track:${args.track_index}` };
    }
    if (name === 'get_track_spectrum') {
      if (!analyzerStreams.supported) return { status: 'streams_unsupported', error: 'no streams' };
      return { bands: { sub: 0.6, mid: 0.1 }, distinct_frames: 8, peak: 0.7, rms: 0.3, stream: `track:${args.track_index}` };
    }
    if (name === 'get_clip_file_path') return { file_path: '/sample.wav' };
    if (name === 'analyze_spectrum_offline') return { band_balance: { mid_2khz: 0.7 } };
    if (name === 'analyze_loudness') return { integrated_lufs: -18 };
    if (name === 'get_taste_graph') return { evidence_count: 0, device_affinities: {} };
    if (name === 'memory_recall') return { techniques: [] };
    if (name === 'consult_ableton_knowledge') return { plan: ['Search corpus'] };
    if (name === 'get_composition_plan') return { plan: structuredClone(composer), dry_run: true, ...composerResult };
    if (name === 'create_midi_track') {
      const index = state.tracks.length;
      state.tracks.push({ index, name: 'New MIDI', solo: false, mute: false });
      return { index };
    }
    if (name === 'set_track_name') {
      state.tracks.find(t => t.index === args.track_index).name = args.name;
      return { ok: true };
    }
    if (name === 'create_scene') { state.scene_count++; return { index: state.scene_count - 1 }; }
    if (name === 'set_scene_name') return { name: args.name };
    if (name === 'get_device_parameters' && parameterFailures.has(args.device_index)) throw new Error(parameterFailures.get(args.device_index));
    if (name === 'get_device_parameters') return { parameters: [{ index: 0, name: 'Brightness', value, min: 0, max: 1,
      value_string: `${value * 100}%`, ...parameterOverrides }] };
    if (name === 'propose_synth_branches' && synthFailures.has(args.device_index)) throw new Error(synthFailures.get(args.device_index));
    if (name === 'propose_synth_branches' && synthWarnings.has(args.device_index)) return { compiled_plans: [], warnings: [synthWarnings.get(args.device_index)] };
    if (name === 'propose_synth_branches') return args.device_index !== 0 ? { compiled_plans: [], warnings: ['No synthesis adapter.'] } : {
      compiled_plans: [{ steps: [{ tool: 'set_device_parameter',
        params: { track_index: args.track_index, device_index: 0, parameter_index: 0, value: 0.6 } }] }],
    };
    if (name === 'set_device_parameter') {
      if (!ignoreWrites) value = args.value;
      if (failWrite) throw new Error('Connection lost after write');
      return { value };
    }
    throw new Error(`Unexpected tool: ${name}`);
  };
  const creative = createCreative(call, { sleep: async () => {} });
  return { creative, chooseBranch: () => creative.run({ action: 'chooseBranch', branch_id: creative.snapshot().branches.id, branch_index: 0 }),
    calls, state, composer, composerResult, devices, parameterOverrides, analyzerStreams, synthFailures, synthWarnings, parameterFailures,
    failSpectrum: () => { failSpectrum = true; }, failWrite: () => { failWrite = true; },
    failRestore: () => { failRestore = true; }, changeValue: v => { value = v; },
    ignoreWrites: () => { ignoreWrites = true; } };
}
function browserDocument(html) {
  const nodes = new Map();
  const node = tag => ({
    tagName: tag?.toUpperCase(),
    value: '', disabled: false, hidden: false, textContent: '', isConnected: true, children: [],
    dataset: {}, style: {}, classList: { toggle() {}, add() {} }, setAttribute() {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    insertBefore(item, reference) {
      this.lastInsertion = [item, reference];
      (this.insertions ??= []).push([item, reference]);
    },
    get firstChild() { return this.children[0]; },
    reportValidity() { return true; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() {},
  });
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, node());
  for (const id of ['theme-selector', 'ableton-launch', 'live-transport']) nodes.get(id).disabled = true;
  const document = {
    getElementById: id => {
      assert.ok(nodes.has(id), `Element ${id} is not declared in the document`);
      return nodes.get(id);
    },
    createElement: node, querySelector: () => ({ content: 'token' }),
    querySelectorAll: () => [...nodes.values()],
    documentElement: { style: { removeProperty() {}, setProperty() {} } },
    body: node(),
  };
  return { nodes, document };
}
test('scans all tracks without writes and marks stopped meters as peak-hold', async () => {
  const f = fixture();
  f.state.is_playing = false;
  const data = await f.creative.run({ action: 'scan' });
  assert.equal(data.dashboard.tracks.length, 3);
  assert.equal(data.dashboard.tracks[0].meter.is_playing, false);
  assert.equal(f.calls.some(c => c.name.startsWith('set_')), false);
});
test('focus requires an explicit scope and selects only requested tracks without musical writes', async () => {
  const f = fixture();
  await assert.rejects(f.creative.run({ action: 'focus', mood: 'Warmth / comfort' }), /Choose selected tracks or the whole song/);
  for (const track_indices of [[], [99], ['0']]) {
    await assert.rejects(f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices }), /Choose at least one current track/);
  }
  const start = f.calls.length;
  const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
  assert.deepEqual(result.focus.tracks.map(t => t.index), [0]);
  assert.equal(result.focus.tracks[0].devices[0].name, 'Wavetable');
  const p = result.focus.tracks[0].devices[0].parameters[0];
  assert.equal(p.name, 'Brightness');
  assert.equal(p.value_string, '30%');
  assert.equal(p.suggestion.value, 0.25);
  assert.match(p.suggestion.reason, /darker/);
  assert.deepEqual([...new Set(f.calls.slice(start).filter(c => c.name === 'get_device_parameters').map(c => c.args.track_index))], [0]);
  assert.equal(f.calls.some(c => c.name.startsWith('set_')), false);
  const song = await f.creative.run({ action: 'focus', suggestion: 'brighter', scope: 'song' });
  assert.deepEqual(song.focus.tracks.map(t => t.index), [0, 1, -1000]);
  assert.equal(song.focus.tracks.at(-1).devices.length, 0, 'Analyzer is not a creative target');
  assert.equal(f.calls.some(c => c.name.startsWith('set_')), false);
});
test('focus exposes real plugin knobs without pretending unknown text has a calibrated target', async () => {
  const f = fixture();
  f.devices[0] = { index: 0, name: 'Plugin One', class_name: 'PluginDevice' };
  f.parameterOverrides.name = 'Custom Macro';
  let result = await f.creative.run({ action: 'focus', suggestion: 'a shape not in the direction map', scope: 'tracks', track_indices: [0] });
  assert.equal(result.focus.tracks[0].devices[0].parameters[0].suggestion, null);
  const focus_id = result.focus.id;
  result = await f.creative.run({ action: 'applyFocus', focus_id, track_index: 0, device_index: 0,
    parameter_index: 0, reviewed_value: 0.3, value: 0.4, confirmed: true });
  assert.match(result.changes[0].label, /Plugin One \/ Custom Macro/);
  assert.equal(result.focus.tracks[0].devices[0].parameters[0].value, 0.4);
  assert.equal(result.changes[0].state, 'active');
});
test('focus changes reuse verified before/after recovery and preserve an existing Composer plan', async () => {
  const f = fixture();
  const original = await f.creative.run({ action: 'compose', mood: 'Warmth / comfort' });
  const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
  const input = { action: 'applyFocus', focus_id: result.focus.id, track_index: 0, device_index: 0,
    parameter_index: 0, reviewed_value: 0.3, value: 0.25, confirmed: true };
  await assert.rejects(f.creative.run({ ...input, confirmed: false }), /Approve this knob/);
  for (const value of [NaN, Infinity, -1, 2, '0.2']) await assert.rejects(f.creative.run({ ...input, value }), /inside this knob range/);
  const changed = await f.creative.run(input);
  assert.equal(changed.plan.id, original.plan.id);
  assert.equal(changed.plan.next, 0);
  assert.equal(changed.changes[0].before, 0.3);
  assert.equal(changed.changes[0].after, 0.25);
  const recover = { action: 'recover', change_id: changed.changes[0].id, confirmed: true };
  const bypass = await f.creative.run({ ...recover, mode: 'bypass' });
  assert.equal(bypass.focus.tracks[0].devices[0].parameters[0].value, 0.3);
  assert.equal(bypass.changes[0].state, 'bypassed');
  await f.creative.run({ ...recover, mode: 'enable' });
  const revert = await f.creative.run({ ...recover, mode: 'revert' });
  assert.equal(revert.focus.tracks[0].devices[0].parameters[0].value, 0.3);
  assert.equal(revert.changes[0].state, 'reverted');
  assert.equal(f.calls.some(c => c.name === 'undo'), false);
});
test('focus refuses stale reviews, altered ranges, moved devices and external knob changes', async () => {
  for (const mutation of ['value', 'range', 'device', 'session', 'id', 'review']) {
    const f = fixture();
    const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
    const input = { action: 'applyFocus', focus_id: result.focus.id, track_index: 0, device_index: 0,
      parameter_index: 0, reviewed_value: 0.3, value: 0.25, confirmed: true };
    if (mutation === 'value') f.changeValue(0.5);
    if (mutation === 'range') f.parameterOverrides.max = 2;
    if (mutation === 'device') f.devices[0].name = 'Replacement';
    if (mutation === 'session') f.state.session_instance_id = 'another';
    if (mutation === 'id') input.focus_id = 'older';
    if (mutation === 'review') input.reviewed_value = 0.1;
    await assert.rejects(f.creative.run(input), /changed|stale|fresh/i, mutation);
    assert.equal(f.calls.some(c => c.name === 'set_device_parameter'), false, mutation);
  }
});
test('failed focus writes remain uncertain and cannot be retried blindly', async () => {
  const f = fixture();
  const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
  const input = { action: 'applyFocus', focus_id: result.focus.id, track_index: 0, device_index: 0,
    parameter_index: 0, reviewed_value: 0.3, value: 0.25, confirmed: true };
  f.failWrite();
  await assert.rejects(f.creative.run(input), /Do not retry blindly/);
  assert.equal(f.creative.snapshot().changes[0].state, 'uncertain');
  await assert.rejects(f.creative.run(input), /uncertain write/);
  assert.equal(f.calls.filter(c => c.name === 'set_device_parameter').length, 1);
});
test('focus filters readonly and invalid metadata, and discrete controls require integer targets', async () => {
  for (const override of [{ is_enabled: false }, { is_read_only: true }, { min: 1, max: 1 }, { value: NaN }]) {
    const f = fixture();
    Object.assign(f.parameterOverrides, override);
    const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
    assert.equal(result.focus.tracks[0].devices.length, 0);
  }
  const f = fixture();
  Object.assign(f.parameterOverrides, { is_quantized: true, min: 0, max: 3 });
  f.changeValue(1);
  const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
  assert.equal(result.focus.tracks[0].devices[0].parameters[0].suggestion, null);
  await assert.rejects(f.creative.run({ action: 'applyFocus', focus_id: result.focus.id, track_index: 0, device_index: 0,
    parameter_index: 0, reviewed_value: 1, value: 1.5, confirmed: true }), /inside this knob range/);
});
test('creative knob targets are bounded small trials; unknown directions and discrete choices are not guessed', () => {
  const p = { name: 'Brightness', min: 0, max: 1, value: 0.99 };
  assert.equal(suggestKnob(p, { mood: 'Euphoria / release' }).value, 1);
  assert.equal(suggestKnob({ ...p, value: 1 }, { mood: 'Euphoria / release' }), null);
  assert.equal(suggestKnob(p, { suggestion: 'unknown image' }), null);
  assert.equal(suggestKnob({ ...p, is_quantized: true }, { mood: 'Euphoria / release' }), null);
});
test('very small plugin ranges remain adjustable and ignored writes cannot look verified', async () => {
  for (const ignored of [false, true]) {
    const f = fixture();
    f.parameterOverrides.max = 0.0001;
    f.changeValue(0.00003);
    const result = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
    const p = result.focus.tracks[0].devices[0].parameters[0];
    assert.ok(p.suggestion);
    const input = { action: 'applyFocus', focus_id: result.focus.id, track_index: 0, device_index: 0,
      parameter_index: 0, reviewed_value: p.value, value: p.suggestion.value, confirmed: true };
    if (ignored) {
      f.ignoreWrites();
      await assert.rejects(f.creative.run(input), /readback does not match/);
      assert.equal(f.creative.snapshot().changes[0].state, 'uncertain');
    } else {
      const changed = await f.creative.run(input);
      assert.equal(changed.changes[0].state, 'active');
      const reverted = await f.creative.run({ action: 'recover', change_id: changed.changes[0].id, mode: 'revert', confirmed: true });
      assert.equal(reverted.focus.tracks[0].devices[0].parameters[0].value, 0.00003);
    }
  }
});
test('group trees preserve real nested membership and keep returns and master at the root', () => {
  const tree = buildTrackTree([
    { index: 0, name: 'Group', is_foldable: true, is_grouped: false, group_track_index: null },
    { index: 1, name: 'Member', is_grouped: true, group_track_index: 0 },
    { index: 2, name: 'Nested', is_foldable: true, is_grouped: true, group_track_index: 0 },
    { index: 3, name: 'Nested member', is_grouped: true, group_track_index: 2 },
    { index: 4, name: 'Separate', is_grouped: false, group_track_index: null },
    { index: -1, name: 'Return' }, { index: -1000, name: 'Master', master: true },
  ]);
  assert.deepEqual(tree.warnings, []);
  assert.equal(tree.complete, true);
  assert.deepEqual(tree.roots, [
    { track_index: 0, children: [{ track_index: 1, children: [] }, { track_index: 2, children: [{ track_index: 3, children: [] }] }] },
    { track_index: 4, children: [] }, { track_index: -1, children: [] }, { track_index: -1000, children: [] },
  ]);
});
test('group trees never guess parents from track order or names and expose invalid metadata', () => {
  const tree = buildTrackTree([
    { index: 0, name: 'Same name', is_foldable: true },
    { index: 1, name: 'Same name', is_grouped: true },
    { index: 2, name: 'Missing parent', is_grouped: true, group_track_index: 90 },
    { index: 3, name: 'Not a group', is_grouped: true, group_track_index: 1 },
    { index: 4, name: 'Self', is_foldable: true, is_grouped: true, group_track_index: 4 },
    { index: 5, name: 'Empty group', is_foldable: true },
  ]);
  assert.equal(tree.warnings.length, 4);
  assert.equal(tree.complete, false);
  assert.deepEqual(tree.roots.map(n => n.track_index), [0, 1, 2, 3, 4, 5]);
  assert.ok(tree.roots.every(n => n.children.length === 0));
});
test('cyclic grouping cannot drop tracks, duplicate tracks or recurse forever', () => {
  const tree = buildTrackTree([
    { index: 0, name: 'A', is_foldable: true, is_grouped: true, group_track_index: 1 },
    { index: 1, name: 'B', is_foldable: true, is_grouped: true, group_track_index: 0 },
    { index: 2, name: 'Member', is_grouped: true, group_track_index: 1 },
  ]);
  assert.equal(tree.warnings.length, 3);
  assert.deepEqual(tree.roots.map(n => n.track_index), [0, 1, 2]);
  assert.ok(tree.roots.every(n => n.children.length === 0));
});
test('scanned snapshots rebuild grouping after refresh and retain warnings for older Remote Scripts', async () => {
  const f = fixture();
  f.state.tracks[0].is_foldable = true;
  f.state.tracks[1].is_grouped = true;
  let data = await f.creative.run({ action: 'scan' });
  assert.match(data.dashboard.warnings.join(' '), /group membership is unavailable/);
  assert.equal(data.dashboard.grouping_complete, false);
  f.state.tracks[1].group_track_index = 0;
  data = await f.creative.run({ action: 'scan' });
  assert.equal(data.dashboard.grouping_complete, true);
  assert.deepEqual(data.dashboard.track_tree[0].children, [{ track_index: 1, children: [] }]);
  f.state.tracks[1].is_grouped = false;
  f.state.tracks[1].group_track_index = null;
  data = await f.creative.run({ action: 'scan' });
  assert.deepEqual(data.dashboard.track_tree.map(n => n.track_index), [0, 1, -1000]);
  assert.equal(f.calls.some(c => c.name.startsWith('set_')), false);
});
test('isolated analysis requires confirmation and restores all prior solos on success', async () => {
  const f = fixture();
  await f.creative.run({ action: 'scan' });
  await assert.rejects(f.creative.run({ action: 'isolated', track_index: 0 }), /Confirm/);
  const data = await f.creative.run({ action: 'isolated', track_index: 0, confirmed: true });
  assert.deepEqual(f.state.tracks.map(t => t.solo), [false, true]);
  assert.equal(data.report.mode, 'isolated through master');
  assert.match(data.report.scope, /Not a pre-master stem/);
  assert.equal(data.report.spectrum.detected_key, undefined);
  assert.equal(data.report.spectrum.mix_wide_key_history.key, 'C');
});
test('restores solos after measurement errors and explicitly reports restoration failures', async () => {
  const f = fixture();
  await f.creative.run({ action: 'scan' });
  f.failSpectrum();
  await assert.rejects(f.creative.run({ action: 'isolated', track_index: 0, confirmed: true }), /Analyzer offline/);
  assert.deepEqual(f.state.tracks.map(t => t.solo), [false, true]);
  f.failRestore();
  await assert.rejects(f.creative.run({ action: 'isolated', track_index: 0, confirmed: true }), /SOLO RESTORATION REQUIRES ATTENTION/);
});
test('offline source analysis does not change solo or transport and labels source scope', async () => {
  const f = fixture();
  const result = await f.creative.run({ action: 'offline', track_index: 0, clip_index: 0 });
  assert.match(result.report.scope, /Original audio source/);
  assert.equal(f.calls.some(c => c.name.startsWith('set_')), false);
  await assert.rejects(f.creative.run({ action: 'offline', track_index: 0, clip_index: 5 }), /occupied/);
});
test('creative advice covers every track, labels hypotheses, and prioritizes measured headroom', async () => {
  const f = fixture();
  await f.creative.run({ action: 'scan' });
  const result = await f.creative.run({ action: 'knowledge', mood: 'dreamy', texture: 'evolving', preferences: 'gentle' });
  assert.equal(result.guidance.ranked.length, 3);
  assert.equal(result.guidance.ranked[0].track_name, 'Kick');
  assert.equal(result.guidance.ranked[0].priority, 100);
  assert.ok(result.guidance.ranked.find(t => t.track_name === 'Pad').advice.some(a => /hypothesis/.test(a.basis)));
  assert.equal(adviseTrack({ index: 0, name: 'Kick', meter: { is_playing: false, level: 1 } }, {}, {}, null).priority, 10);
});
test('a custom suggestion works without preset choices and reaches advice and Composer without applying changes', async () => {
  const f = fixture();
  const suggestion = 'Keep the rhythm intact and develop only the upper layers';
  const advice = await f.creative.run({ action: 'knowledge', suggestion });
  assert.equal(advice.intent.mood, '');
  assert.equal(advice.intent.texture, '');
  assert.equal(advice.intent.suggestion, suggestion);
  assert.match(f.calls.find(c => c.name === 'memory_recall').args.query, /develop only the upper layers/);
  assert.match(f.calls.find(c => c.name === 'consult_ableton_knowledge').args.question, /Keep the rhythm intact/);
  const result = await f.creative.run({ action: 'compose', suggestion });
  assert.match(result.plan.prompt, /Your own suggestion: Keep the rhythm intact/);
  assert.equal(result.plan.intent.suggestion, suggestion);
  assert.equal(f.calls.some(c => /^(set_|create_|add_|insert_|load_)/.test(c.name)), false);
});
test('custom suggestions are trimmed, length-limited, and cannot be passed as non-text', async () => {
  const f = fixture();
  const data = await f.creative.run({ action: 'direction', suggestion: '  My direction  ' });
  assert.equal(data.intent.suggestion, 'My direction');
  await f.creative.run({ action: 'direction', suggestion: 'a'.repeat(2000) });
  for (const suggestion of ['a'.repeat(2001), {}, 42, null]) {
    await assert.rejects(f.creative.run({ action: 'direction', suggestion }), /suggestion must be text/);
  }
  await assert.rejects(f.creative.run({ action: 'compose', suggestion: '   ' }), /Choose a mood or texture/);
});
test('Composer approval is ordered, append-only, and maps created tracks and scenes', async () => {
  const f = fixture();
  let data = await f.creative.run({ action: 'compose', mood: 'calm' });
  const id = data.plan.id;
  await assert.rejects(f.creative.run({ action: 'execute', plan_id: id, step_index: 0 }), /Approve/);
  await assert.rejects(f.creative.run({ action: 'execute', plan_id: id, step_index: 1, confirmed: true }), /Approve/);
  for (let i = 0; i < 4; i++) {
    data = await f.creative.run({ action: 'execute', plan_id: id, step_index: i, confirmed: true });
    const refreshed = await f.creative.run({ action: 'scan' });
    assert.equal(refreshed.plan.id, id, 'Refresh must preserve an in-progress plan after its own approved mutations');
  }
  assert.equal(data.plan.status, 'complete');
  assert.equal(f.state.tracks[0].name, 'Pad');
  assert.equal(f.state.tracks[2].name, 'New Layer');
  assert.equal(f.calls.find(c => c.name === 'create_midi_track').args.index, -1);
  assert.equal(f.calls.find(c => c.name === 'set_scene_name').args.scene_index, 2);
});
test('rejects stale session layout and unsupported tool steps without writes', async () => {
  const f = fixture();
  let data = await f.creative.run({ action: 'compose', mood: 'calm' });
  f.state.tracks[0].name = 'Renamed';
  await assert.rejects(f.creative.run({ action: 'execute', plan_id: data.plan.id, step_index: 0, confirmed: true }), /layout changed/);
  f.composer.splice(0, f.composer.length, { tool: 'delete_track', params: { track_index: 0 } });
  await f.creative.run({ action: 'scan' });
  data = await f.creative.run({ action: 'compose', mood: 'calm' });
  assert.match(data.plan.steps[0].blocked, /not enabled/);
});
test('existing-track branches read before write, verify formatted value, and refuse stale parameter values', async () => {
  const f = fixture();
  await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0, target: { brightness: 0.3 } });
  let data = await f.chooseBranch();
  const result = await f.creative.run({ action: 'execute', plan_id: data.plan.id, step_index: 0, confirmed: true });
  assert.equal(result.plan.steps[0].verified_value, '60%');
  const write = f.calls.findIndex(c => c.name === 'set_device_parameter');
  assert.equal(f.calls[write - 1].name, 'get_device_parameters');
  await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
  data = await f.chooseBranch();
  f.changeValue(0.9);
  await assert.rejects(f.creative.run({ action: 'execute', plan_id: data.plan.id, step_index: 0, confirmed: true }), /Parameter changed/);
});
test('uncertain writes cannot be retried and binding failures are explicit', async () => {
  const f = fixture();
  await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
  const data = await f.chooseBranch();
  f.failWrite();
  const input = { action: 'execute', plan_id: data.plan.id, step_index: 0, confirmed: true };
  await assert.rejects(f.creative.run(input), /partially applied/);
  await assert.rejects(f.creative.run(input), /automatic retry is disabled/);
  assert.deepEqual(resolveBindings({ d: { $from_step: 'a', path: 'index' } }, { a: { index: 4 } }), { d: 4 });
  assert.throws(() => resolveBindings({ $from_step: 'missing' }, {}), /Missing earlier/);
});
test('tempo-only Composer previews with unresolved layers are blocked explicitly', async () => {
  const f = fixture();
  f.composer.splice(0, f.composer.length, { tool: 'set_tempo', params: { tempo: 123 } });
  Object.assign(f.composerResult, { layers: [{ role: 'pad' }], warnings: ['Unresolved sample for pad'] });
  const data = await f.creative.run({ action: 'compose', mood: 'calm' });
  assert.equal(data.plan.status, 'needs_sources');
  await assert.rejects(f.creative.run({ action: 'execute', plan_id: data.plan.id, step_index: 0, confirmed: true }), /Resolve samples/);
});
test('real indices returned through bindings are not remapped a second time', async () => {
  const f = fixture();
  f.composer[1].params.track_index = { $from_step: 'new-track', path: 'index' };
  f.composer[2].step_id = 'new-scene';
  f.composer[3].params.scene_index = { $from_step: 'new-scene', path: 'index' };
  const { plan } = await f.creative.run({ action: 'compose', mood: 'calm' });
  for (let i = 0; i < 4; i++) await f.creative.run({ action: 'execute', plan_id: plan.id, step_index: i, confirmed: true });
  assert.equal(f.calls.find(c => c.name === 'set_track_name').args.track_index, 2);
  assert.equal(f.calls.find(c => c.name === 'set_scene_name').args.scene_index, 2);
});
test('stale branch selections from another window are rejected', async () => {
  const f = fixture();
  const { branches } = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
  await f.creative.run({ action: 'trackPlan', track_index: 1, device_index: 0 });
  await assert.rejects(f.creative.run({ action: 'chooseBranch', branch_id: branches.id, branch_index: 0 }), /branches changed/);
});
test('isolated analysis never starts transport and refuses recording', async () => {
  const f = fixture();
  f.state.is_playing = false;
  await assert.rejects(f.creative.run({ action: 'isolated', track_index: 0, confirmed: true }), /Start playback/);
  f.state.is_playing = true;
  f.state.record_mode = true;
  await assert.rejects(f.creative.run({ action: 'isolated', track_index: 0, confirmed: true }), /Stop recording/);
  assert.equal(f.calls.some(c => c.name.startsWith('set_') || c.name === 'start_playback'), false);
});
async function appliedParameter(f) {
  await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
  const { plan } = await f.chooseBranch();
  return f.creative.run({ action: 'execute', plan_id: plan.id, step_index: 0, confirmed: true });
}
test('saved changes bypass, re-enable, and revert with verified before/after values', async () => {
  const f = fixture();
  let data = await appliedParameter(f);
  const change = data.changes[0];
  assert.equal(change.before_display, '30%');
  assert.equal(change.after_display, '60%');
  assert.equal(change.state, 'active');
  assert.equal('args' in change, false);
  assert.equal('parameter' in change, false);
  const input = { action: 'recover', change_id: change.id, confirmed: true };
  await assert.rejects(f.creative.run({ ...input, confirmed: false, mode: 'bypass' }), /Confirm/);
  for (const [mode, state, value] of [['bypass', 'bypassed', '30%'], ['enable', 'active', '60%'], ['revert', 'reverted', '30%']]) {
    data = await f.creative.run({ ...input, mode });
    assert.equal(data.changes[0].state, state);
    assert.equal(data.changes[0].current_display, value);
  }
  assert.equal(data.plan.status, 'reverted');
  await assert.rejects(f.creative.run({ ...input, mode: 'enable' }), /cannot be toggled/);
  assert.equal(f.calls.some(c => c.name === 'undo' || c.name === 'redo'), false);
});
test('revert while bypassed closes the change without rewriting the setting', async () => {
  const f = fixture();
  const data = await appliedParameter(f);
  const input = { action: 'recover', change_id: data.changes[0].id, confirmed: true };
  await f.creative.run({ ...input, mode: 'bypass' });
  const count = f.calls.filter(c => c.name === 'set_device_parameter').length;
  await f.creative.run({ ...input, mode: 'revert' });
  assert.equal(f.calls.filter(c => c.name === 'set_device_parameter').length, count);
});
test('recovery refuses newer manual edits, changed tracks and changed devices without writes', async () => {
  const f = fixture();
  const data = await appliedParameter(f);
  const input = { action: 'recover', change_id: data.changes[0].id, confirmed: true, mode: 'bypass' };
  const count = f.calls.filter(c => c.name === 'set_device_parameter').length;
  f.changeValue(0.9);
  await assert.rejects(f.creative.run(input), /changed elsewhere/);
  f.changeValue(0.6);
  f.state.tracks[0].name = 'Different';
  await assert.rejects(f.creative.run(input), /Session layout changed/);
  f.state.tracks[0].name = 'Pad';
  f.devices[0].class_name = 'Different';
  await assert.rejects(f.creative.run(input), /layout changed/);
  assert.equal(f.calls.filter(c => c.name === 'set_device_parameter').length, count);
});
test('recovery and execution failures remain uncertain and cannot report a successful bypass', async () => {
  const f = fixture();
  const data = await appliedParameter(f);
  f.failWrite();
  const input = { action: 'recover', change_id: data.changes[0].id, confirmed: true, mode: 'bypass' };
  await assert.rejects(f.creative.run(input), /partially applied/);
  assert.equal(f.creative.snapshot().changes[0].state, 'uncertain');
  await assert.rejects(f.creative.run(input), /cannot be toggled/);
  const other = fixture();
  other.failWrite();
  await assert.rejects(appliedParameter(other), /partially applied/);
  assert.equal(other.creative.snapshot().changes[0].state, 'uncertain');
});
test('changes remain recoverable after a new proposal and newer same-setting edits must be reverted first', async () => {
  const f = fixture();
  const first = (await appliedParameter(f)).changes[0];
  const second = (await appliedParameter(f)).changes[1];
  await assert.rejects(f.creative.run({ action: 'recover', change_id: first.id, mode: 'bypass', confirmed: true }), /newer change/);
  await f.creative.run({ action: 'recover', change_id: second.id, mode: 'revert', confirmed: true });
  const data = await f.creative.run({ action: 'recover', change_id: first.id, mode: 'bypass', confirmed: true });
  assert.equal(data.changes[0].current_display, '30%');
});
test('bypass pauses remaining plan steps; re-enable resumes without losing the saved baseline', async () => {
  const f = fixture();
  f.composer.splice(1, f.composer.length - 1,
    { tool: 'set_device_parameter', params: { track_index: 0, device_index: 0, parameter_index: 0, value: 0.6 } },
    { tool: 'set_device_parameter', params: { track_index: 0, device_index: 0, parameter_index: 0, value: 0.8 } });
  let data = await f.creative.run({ action: 'compose', mood: 'calm' });
  const input = { action: 'execute', plan_id: data.plan.id, confirmed: true };
  await f.creative.run({ ...input, step_index: 0 });
  data = await f.creative.run({ ...input, step_index: 1 });
  const recover = { action: 'recover', change_id: data.changes[0].id, confirmed: true };
  await f.creative.run({ ...recover, mode: 'bypass' });
  await assert.rejects(f.creative.run({ ...input, step_index: 2 }), /Re-enable bypassed/);
  await f.creative.run({ ...recover, mode: 'enable' });
  data = await f.creative.run({ ...input, step_index: 2 });
  assert.equal(data.plan.status, 'complete');
  assert.equal(data.changes[0].before_display, '30%');
  assert.equal(data.changes[1].before_display, '60%');
});
test('a successful tool response without matching readback never becomes a verified outcome', async () => {
  const f = fixture();
  f.ignoreWrites();
  await assert.rejects(appliedParameter(f), /readback does not match/);
  assert.equal(f.creative.snapshot().changes[0].state, 'uncertain');
  const recovery = fixture();
  const data = await appliedParameter(recovery);
  recovery.ignoreWrites();
  await assert.rejects(recovery.creative.run({
    action: 'recover', change_id: data.changes[0].id, confirmed: true, mode: 'bypass',
  }), /readback does not match/);
  assert.equal(recovery.creative.snapshot().changes[0].state, 'uncertain');
});
test('tempo and mixer setting steps capture original values and support independent recovery', async () => {
  for (const [tool, params, before, after] of [
    ['set_tempo', { tempo: 130 }, 123, 130],
    ['set_track_volume', { track_index: 0, volume: 0.5 }, 0.8, 0.5],
    ['set_track_pan', { track_index: 0, pan: -0.5 }, 0, -0.5],
    ['set_track_send', { track_index: 0, send_index: 0, value: 0.3 }, 0, 0.3],
  ]) {
    const f = fixture();
    f.composer.splice(0, f.composer.length, ...(tool === 'set_tempo' ? [] : [f.composer[0]]), { tool, params });
    let data = await f.creative.run({ action: 'compose', mood: 'calm' });
    for (let i = 0; i < data.plan.steps.length; i++) data = await f.creative.run({
      action: 'execute', plan_id: data.plan.id, step_index: i, confirmed: true,
    });
    const change = data.changes[0];
    assert.equal(change.before, before);
    assert.equal(change.after, after);
    data = await f.creative.run({ action: 'recover', change_id: change.id, mode: 'bypass', confirmed: true });
    assert.equal(data.changes[0].state, 'bypassed');
    data = await f.creative.run({ action: 'recover', change_id: change.id, mode: 'enable', confirmed: true });
    assert.equal(data.changes[0].state, 'active');
  }
});
test('transport starts/stops through MCP, verifies state, and converts exclusive bar ranges using the time signature', async () => {
  const f = fixture();
  await f.creative.run({ action: 'transport', command: 'stop' });
  assert.equal(f.creative.snapshot().dashboard.session.is_playing, false);
  await f.creative.run({ action: 'transport', command: 'start' });
  assert.equal(f.creative.snapshot().dashboard.session.is_playing, true);
  for (const [numerator, denominator, start, length] of [[4, 4, 16, 16], [3, 4, 12, 12], [6, 8, 12, 12]]) {
    f.state.signature_numerator = numerator;
    f.state.signature_denominator = denominator;
    const data = await f.creative.run({ action: 'transport', command: 'loop', enabled: true, start_bar: 5, end_bar: 9 });
    assert.equal(data.dashboard.session.loop, true);
    assert.equal(f.state.loop_start, start);
    assert.equal(f.state.loop_length, length);
  }
  await f.creative.run({ action: 'transport', command: 'loop', enabled: false });
  assert.equal(f.state.loop, false);
  assert.equal(f.state.loop_start, 12);
  assert.equal(f.state.loop_length, 12);
});
test('invalid loop ranges, missing time signatures, and unsuccessful readback fail explicitly', async () => {
  const f = fixture();
  for (const [start_bar, end_bar] of [[0, 5], [5, 5], [9, 2], [1, Infinity], [NaN, 5]]) {
    await assert.rejects(f.creative.run({ action: 'transport', command: 'loop', enabled: true, start_bar, end_bar }), /Start bar/);
  }
  delete f.state.signature_denominator;
  await assert.rejects(f.creative.run({ action: 'transport', command: 'loop', enabled: true, start_bar: 1, end_bar: 5 }), /time signature/);
  assert.equal(f.calls.some(c => c.name === 'set_session_loop'), false);
  const broken = createCreative(async name => name === 'get_session_info' ? { tracks: [], is_playing: false } : {});
  await assert.rejects(broken.run({ action: 'transport', command: 'start' }), /readback does not match/);
});
test('Composer is promoted only for verified empty Session and Arrangement tracks', async () => {
  const session = { tracks: [{ index: 0, name: '1 MIDI' }, { index: 1, name: '2 Audio' }],
    return_tracks: [{ index: 0, name: 'A Reverb' }], scene_count: 8 };
  let devices = [];
  let slots = [{ index: 0, has_clip: false }];
  let arrangement = [];
  let unavailable = false;
  const creative = createCreative(async (name, args) => {
    if (name === 'get_session_info') return structuredClone(session);
    if (name === 'get_track_meters') return { tracks: [] };
    if (name === 'get_track_info') return {
      devices: args.track_index < 0 ? [{ name: 'Reverb' }] : structuredClone(devices),
      clip_slots: structuredClone(slots),
    };
    if (name === 'get_arrangement_clips') {
      if (unavailable) throw new Error('Arrangement unavailable');
      return { clips: structuredClone(arrangement) };
    }
    throw new Error(`Unexpected ${name}`);
  });
  assert.equal((await creative.run({ action: 'scan' })).dashboard.is_blank, true);
  slots[0].has_clip = true;
  assert.equal((await creative.run({ action: 'scan' })).dashboard.is_blank, false);
  slots[0].has_clip = false;
  arrangement = [{ index: 0, name: 'Arrangement-only clip' }];
  assert.equal((await creative.run({ action: 'scan' })).dashboard.is_blank, false);
  arrangement = [];
  devices = [{ name: 'Instrument' }];
  assert.equal((await creative.run({ action: 'scan' })).dashboard.is_blank, false);
  devices = [];
  unavailable = true;
  const result = await creative.run({ action: 'scan' });
  assert.equal(result.dashboard.is_blank, false);
  assert.match(result.dashboard.warnings.join(' '), /Arrangement unavailable/);
  unavailable = false;
  session.tracks = [];
  assert.equal((await creative.run({ action: 'scan' })).dashboard.is_blank, true);
});
async function appBrowser({ running = false, installed = true, statusError, readError, launchError, stalled = false } = {}) {
  const html = await readFile(new URL('creative.html', import.meta.url), 'utf8');
  const code = await readFile(new URL('creative-client.js', import.meta.url), 'utf8');
  const { nodes, document } = browserDocument(html);
  const f = fixture();
  const requests = [];
  const context = vm.createContext({ document, window: { name: '', confirm: () => true }, location: { pathname: '/' },
    setTimeout: resolve => queueMicrotask(resolve),
    fetch: async (path, request) => {
      requests.push(path);
      let result;
      let error;
      if (path === '/ableton-status') {
        error = statusError;
        result = { supported: true, running, installed };
      } else if (path === '/ableton-launch') {
        error = launchError;
        if (!stalled && !error) running = true;
        result = { supported: true, running: false, installed, launch_requested: true };
      } else if (path === '/themes') result = { themes: [{ id: 'studio', name: 'Studio', scheme: 'dark', vars: {} }],
        selected: 'studio', warnings: [] };
      else if (readError) error = readError;
      else result = path === '/creative' ? await f.creative.run(JSON.parse(request.body)) : f.creative.snapshot();
      return { ok: !error, json: async () => error ? { error } : result };
    },
  });
  vm.runInContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, nodes, requests, f };
}
test('stopped Ableton enables the title, skips MCP reads and launches only on an explicit click', async () => {
  const b = await appBrowser();
  assert.equal(b.nodes.get('ableton-launch').disabled, false);
  assert.equal(b.nodes.get('live-transport').disabled, true);
  assert.match(b.nodes.get('ableton-app-status').textContent, /not running.*Click the Studio title/);
  assert.deepEqual(b.requests, ['/ableton-status', '/themes']);
  assert.equal(b.f.calls.length, 0);
  b.nodes.get('track-layout').onchange();
  b.nodes.get('collapse-groups').onclick();
  b.nodes.get('focus-scope').value = 'tracks';
  b.nodes.get('focus-scope').onchange();
  assert.match(b.nodes.get('group-status').textContent, /No session loaded/);
  assert.equal(b.nodes.get('focus-track-picker').hidden, false);
  assert.match(b.nodes.get('focus-tracks').children[0].textContent, /Connect Ableton/);
  assert.equal(b.f.calls.length, 0, 'Offline layout controls must remain local and usable');
  await vm.runInContext('launchAbleton()', b.context);
  assert.equal(b.requests.filter(path => path === '/ableton-launch').length, 1);
  assert.equal(b.nodes.get('ableton-launch').disabled, true);
  assert.equal(b.nodes.get('live-transport').disabled, false);
  assert.match(b.nodes.get('status').textContent, /running and its session is loaded/);
  assert.equal(b.f.calls.some(c => /^(set_|start_playback|stop_playback)/.test(c.name)), false);
});
test('running Ableton stays distinct from a disconnected MCP server and is never auto-launched', async () => {
  const b = await appBrowser({ running: true, readError: 'LivePilot MCP is not available in this session.' });
  assert.match(b.nodes.get('ableton-app-status').textContent, /Ableton Live is running/);
  assert.equal(b.nodes.get('ableton-launch').disabled, true);
  assert.match(b.nodes.get('status').textContent, /MCP is not available/);
  assert.equal(b.requests.includes('/ableton-launch'), false);
});
test('missing applications and failed detection never expose a misleading start button', async () => {
  for (const options of [{ installed: false }, { statusError: 'Could not check Ableton' }]) {
    const b = await appBrowser(options);
    assert.equal(b.nodes.get('ableton-launch').disabled, true);
    assert.equal(b.nodes.get('live-transport').disabled, true);
    assert.match(b.nodes.get('ableton-app-status').textContent, /not installed|Could not check/);
    assert.equal(b.requests.includes('/creative'), false);
  }
});
test('failed or stalled launches are explicit and a manual refresh rechecks native app state', async () => {
  for (const options of [{ launchError: 'Launch failed' }, { stalled: true }]) {
    const b = await appBrowser(options);
    await vm.runInContext('launchAbleton()', b.context);
    assert.match(b.nodes.get('status').textContent, /Launch failed|not appeared during the startup checks/);
    assert.equal(b.nodes.get('ableton-launch').disabled, false);
    assert.equal(b.nodes.get('live-transport').disabled, true);
    assert.equal(b.requests.includes('/creative'), false);
    const before = b.requests.filter(path => path === '/ableton-status').length;
    await vm.runInContext('refreshAbletonSession()', b.context);
    assert.equal(b.requests.filter(path => path === '/ableton-status').length, before + 1);
  }
});
test('M4L windows retain the clicked track, ordered sections and scoped suggestions across refreshes', async () => {
  const html = await readFile(new URL('creative.html', import.meta.url), 'utf8');
  const code = await readFile(new URL('creative-client.js', import.meta.url), 'utf8');
  const f = fixture();
  await f.creative.run({ action: 'scan' });
  await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0] });
  const { nodes, document } = browserDocument(html);
  const opened = [];
  const requests = [];
  const context = vm.createContext({ document, window: { name: '', confirm: () => true,
    open: (...args) => { opened.push(args); return {}; } }, location: { pathname: '/track/1' },
    fetch: async (path, request) => {
      const input = JSON.parse(request.body);
      requests.push({ path, input });
      return { ok: true, json: async () => path === '/themes' ?
        { themes: [{ id: 'studio', name: 'Studio', scheme: 'dark', vars: {} }], selected: 'studio', warnings: [] } :
        path === '/ableton-status' ? { supported: true, running: true, installed: true } :
        path === '/creative' ? f.creative.run(input) : f.creative.snapshot() };
    },
  });
  vm.runInContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.title, /^Kick .*Countryside Creative Studio$/);
  assert.equal(nodes.get('scope-label').textContent, 'Creative context: Kick');
  assert.equal(nodes.get('detail-title').textContent, 'Kick / Track analysis');
  assert.deepEqual(nodes.get('studio-layout').insertions.slice(0, 2), [
    [nodes.get('direction-section'), nodes.get('advice-section')],
    [nodes.get('track-detail'), nodes.get('advice-section')],
  ]);
  assert.equal(nodes.get('focus-scope').value, 'tracks');
  const choices = nodes.get('focus-tracks').children;
  assert.equal(choices[0].children[0].checked, false);
  assert.equal(choices[1].children[0].checked, true);
  assert.equal(nodes.get('advice-list').children[0].children[0].textContent, 'Kick',
    'The window must show only the opened track’s actual controls');
  nodes.get('mood').value = 'Warmth / comfort';
  nodes.get('mood').onchange();
  await nodes.get('focus-suggest').onclick();
  await new Promise(resolve => setImmediate(resolve));
  const focus = requests.find(r => r.input.action === 'focus').input;
  assert.equal(focus.track_index, 1);
  assert.deepEqual(focus.track_indices, [1]);
  assert.equal(nodes.get('advice-list').children[0].children[0].textContent, 'Kick');
  await nodes.get('refresh').onclick();
  assert.equal(nodes.get('detail-title').textContent, 'Kick / Track analysis');
  assert.ok(requests.filter(r => r.input.action === 'inspect').every(r => r.input.track_index === 1));
  vm.runInContext('openTrack(1); openTrack(0); openTrack(-1000)', context);
  assert.deepEqual(opened.map(args => args.slice(0, 2)), [
    ['/track/1', 'livepilot-track-1'], ['/track/0', 'livepilot-track-0'], ['/track/-1000', 'livepilot-track--1000'],
  ]);
  assert.equal(f.calls.some(c => /^(set_|start_playback|stop_playback)/.test(c.name)), false);
});
test('track analysis reserves chart space only when spectral bands exist', async () => {
  const css = await readFile(new URL('creative.css', import.meta.url), 'utf8');
  assert.match(css, /\.spectrum:empty\s*\{\s*display:\s*none\s*\}/);
});
test('creative transport header stays outside the scrolling workspace', async () => {
  const html = await readFile(new URL('creative.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('creative.css', import.meta.url), 'utf8');
  assert.match(html, /<\/header>\s*<div class="studio-content"[^>]*tabindex="0">\s*<main id="studio-layout">/);
  assert.match(html, /<\/footer>\s*<\/div>\s*<dialog/);
  for (const id of ['transport-start', 'transport-stop', 'transport-loop', 'loop-start', 'loop-end', 'loop-apply']) {
    assert.ok(html.indexOf(`id="${id}"`) < html.indexOf('</header>'), `${id} must remain in the fixed header`);
  }
  assert.match(css, /body\[data-studio-version\]\{[^}]*height:100dvh;overflow:hidden/);
  assert.match(css, /\.studio-content\{[^}]*min-height:0;overflow-y:auto/);
});
test('creative dashboard and track document initialize with visible controls, reports, and branches', async () => {
  const html = await readFile(new URL('creative.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/<section[^>]*aria-labelledby="([^"]+)"/g)].map(m => m[1]),
    ['tracks-title', 'advice-title', 'intent-title', 'memory-title', 'detail-title', 'plan-title', 'warnings-title']);
  const sections = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)];
  assert.equal(sections.length, 7);
  for (const [section, content] of sections) {
    assert.match(content, /^\s*<details class="section-panel" open>\s*<summary>/);
    const title = section.match(/aria-labelledby="([^"]+)"/)[1];
    assert.match(content.match(/<summary>([\s\S]*?)<\/summary>/)[1], new RegExp(`id="${title}"`));
    assert.doesNotMatch(content.match(/<summary>([\s\S]*?)<\/summary>/)[1], /<(?:button|input|select)\b/);
    assert.match(content, /<\/details>\s*$/);
  }
  assert.ok(html.indexOf('id="theme-selector"') > html.indexOf('<footer>'));
  const code = await readFile(new URL('creative-client.js', import.meta.url), 'utf8');
  for (const pathname of ['/', '/track/0']) {
    const f = fixture();
    await f.creative.run({ action: 'scan' });
    await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
    await f.chooseBranch();
    const { nodes, document } = browserDocument(html);
    const context = vm.createContext({ document, window: { name: '', confirm: () => true }, location: { pathname },
      fetch: async (path, request) => ({ ok: true, json: async () => path === '/themes'
        ? { themes: [{ id: 'studio', name: 'Studio', scheme: 'dark', vars: {} }], selected: 'studio', warnings: [] }
        : path === '/ableton-status' ? { supported: true, running: true, installed: true }
        : path === '/creative' ? f.creative.run(JSON.parse(request.body)) : f.creative.snapshot() }),
    });
    vm.runInContext(code, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(nodes.get('status').textContent, /Ready/);
    assert.equal(nodes.get('theme-selector').disabled, false);
    assert.equal(nodes.get('ableton-launch').disabled, true, 'An active Ableton must not appear stopped');
    assert.equal(nodes.get('live-transport').disabled, false);
    assert.equal(nodes.get('tracks').children.length, 3);
    assert.equal(nodes.get('plan-steps').children.length, 1);
    assert.equal(nodes.get('mood').children.length, 8, 'Seven mood options plus an empty choice');
    assert.equal(nodes.get('texture').children.length, 9, 'Eight texture options plus an empty choice');
    assert.equal(nodes.get('mood').children[0].value, '');
    assert.equal(nodes.get('texture').children[0].value, '');
    assert.equal(nodes.get('suggestion').value, '');
    const callsBeforeSelection = f.calls.length;
    nodes.get('mood').value = 'Warmth / comfort';
    nodes.get('mood').onchange();
    nodes.get('texture').value = 'Organic / evolving';
    nodes.get('texture').onchange();
    nodes.get('suggestion').value = 'Keep the source recognizable';
    nodes.get('suggestion').oninput();
    assert.match(nodes.get('mood-insight').textContent, /Gentle harmonics/);
    assert.match(nodes.get('texture-insight').textContent, /filter breathing/);
    assert.equal(f.calls.length, callsBeforeSelection, 'Choosing directions is local, not an Ableton edit');
    const callsBeforeScope = f.calls.length;
    if (pathname === '/') {
      nodes.get('focus-suggest').onclick();
      assert.match(nodes.get('status').textContent, /Choose the whole song/);
      assert.equal(f.calls.length, callsBeforeScope, 'Missing scope must not dispatch requests');
    }
    nodes.get('focus-scope').value = 'tracks';
    nodes.get('focus-scope').onchange();
    assert.equal(nodes.get('focus-track-picker').hidden, false);
    const choice = nodes.get('focus-tracks').children[0].children[0];
    choice.checked = true;
    choice.onchange();
    assert.equal(f.calls.length, callsBeforeScope, 'Selecting scope and tracks is local');
    await vm.runInContext("action('focus', {...direction(), scope:'tracks', track_indices:[0]})", context);
    assert.match(nodes.get('outcome-title').textContent, /Ideas ready.*nothing applied/);
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    let controls = descendants(nodes.get('advice-list'));
    const adopt = controls.find(n => n.textContent === 'Adopt idea (draft only)');
    assert.ok(adopt);
    const beforeDraft = f.calls.length;
    adopt.onclick();
    let numeric = controls.find(n => n.type === 'number');
    assert.equal(numeric.value, '0.25');
    numeric.value = '0.22';
    numeric.oninput();
    vm.runInContext('render()', context);
    controls = descendants(nodes.get('advice-list'));
    numeric = controls.find(n => n.type === 'number');
    assert.equal(numeric.value, '0.22', 'Draft knob targets survive redraws');
    assert.equal(f.calls.length, beforeDraft, 'Adopting and adjusting knobs is draft-only');
    assert.equal(controls.find(n => n.textContent === 'Apply this knob').disabled, false);
    await vm.runInContext("action('scan')", context);
    assert.equal(nodes.get('mood').value, 'Warmth / comfort', 'Refresh preserves unsubmitted selections');
    assert.equal(nodes.get('suggestion').value, 'Keep the source recognizable');
    await vm.runInContext("action('knowledge', direction())", context);
    assert.equal(f.creative.snapshot().intent.suggestion, 'Keep the source recognizable');
    assert.equal(f.creative.snapshot().intent.texture, 'Organic / evolving');
    await vm.runInContext("action('direction', {mood:'dreamy'})", context);
    assert.equal(nodes.get('mood').value, 'dreamy');
    assert.ok(nodes.get('mood').children.some(o => o.value === 'dreamy'), 'Saved custom values remain selectable');
    assert.equal(nodes.get('suggestion').value, '');
    assert.equal(nodes.get('loop-start').value, '1');
    assert.equal(nodes.get('loop-end').value, '5');
    assert.equal(typeof nodes.get('transport-start').onclick, 'function');
    assert.equal(typeof nodes.get('transport-stop').onclick, 'function');
    assert.equal(typeof nodes.get('transport-loop').onclick, 'function');
    assert.equal(nodes.get('plan-steps').children[0].children.some(n => n.tagName === 'PRE'), false);
    await vm.runInContext("action('knowledge', {mood:'calm'})", context);
    assert.equal(nodes.get('outcome-dialog').open, true);
    assert.match(nodes.get('outcome-title').textContent, /nothing applied/);
    assert.equal(f.calls.some(c => c.name === 'set_device_parameter'), false);
    await vm.runInContext("action('execute', {plan_id:data.plan.id, step_index:0, confirmed:true})", context);
    assert.match(nodes.get('outcome-title').textContent, /Applied.*verified/);
    assert.match(nodes.get('outcome-body').textContent, /30% to 60%/);
    assert.equal(nodes.get('applied-changes').children.length, 1);
    await vm.runInContext("action('recover', {change_id:data.changes[0].id, mode:'bypass', confirmed:true})", context);
    assert.match(nodes.get('outcome-title').textContent, /Bypassed/);
    assert.match(nodes.get('outcome-body').textContent, /30%/);
    await vm.runInContext("action('recover', {change_id:data.changes[0].id, mode:'enable', confirmed:true})", context);
    assert.match(nodes.get('outcome-title').textContent, /Re-enabled/);
    await vm.runInContext("action('recover', {change_id:data.changes[0].id, mode:'revert', confirmed:true})", context);
    assert.match(nodes.get('outcome-title').textContent, /Reverted/);
    await vm.runInContext("action('recover', {change_id:data.changes[0].id, mode:'enable', confirmed:true})", context);
    assert.match(nodes.get('outcome-title').textContent, /Request failed/);
    assert.match(nodes.get('status').textContent, /cannot be toggled/);
    assert.deepEqual(nodes.get('studio-layout').lastInsertion, [nodes.get('composer-section'), nodes.get('warnings-section')]);
    vm.runInContext('data.dashboard.is_blank = true; render();', context);
    assert.deepEqual(nodes.get('studio-layout').lastInsertion, [nodes.get('composer-section'),
      nodes.get(pathname === '/' ? 'track-section' : 'warnings-section')]);
    vm.runInContext('data.dashboard.is_blank = false; render();', context);
    assert.deepEqual(nodes.get('studio-layout').lastInsertion, [nodes.get('composer-section'), nodes.get('warnings-section')]);
    if (pathname !== '/') {
      assert.equal(nodes.get('track-detail').hidden, false);
      assert.equal(nodes.get('instrument').children.length, 2);
      assert.equal(nodes.get('plan-steps').children.length, 1,
        'Reading controls must not discard the existing plan');
      assert.equal(typeof nodes.get('track-analyzer').onclick, 'function');
    }
    await vm.runInContext("action('focus', {mood:'Warmth / comfort', scope:'tracks', track_indices:[0]})", context);
    const previousPlan = f.creative.snapshot().plan.id;
    await vm.runInContext("action('applyFocus', {focus_id:data.focus.id, track_index:0, device_index:0, parameter_index:0, reviewed_value:0.3, value:0.4, confirmed:true})", context);
    assert.match(nodes.get('outcome-title').textContent, /Applied and verified/);
    assert.match(nodes.get('outcome-body').textContent, /30% to 40%/);
    assert.equal(f.creative.snapshot().plan.id, previousPlan, 'Inline knob exploration preserves the plan');
    let inlineControls = descendants(nodes.get('advice-list'));
    assert.ok(inlineControls.find(n => n.textContent === 'Bypass / hear before'), 'Recovery controls are in the focus section');
    const focusChange = f.creative.snapshot().focus.tracks[0].devices[0].parameters[0].change_id;
    await vm.runInContext(`action('recover', {change_id:'${focusChange}', mode:'revert', confirmed:true})`, context);
    inlineControls = descendants(nodes.get('advice-list'));
    assert.ok(inlineControls.find(n => /Current in Ableton: 30%/.test(n.textContent)), 'Revert updates the inline knob readout');
    const callsBeforeGrouping = f.calls.length;
    vm.runInContext(`
      data.dashboard.tracks = [
        {...data.dashboard.tracks[0], name:'Outer', is_foldable:true, is_grouped:false, group_track_index:null},
        {index:2, name:'Nested', is_foldable:true, is_grouped:true, group_track_index:0, fold_state:true},
        {...data.dashboard.tracks[1], is_grouped:true, group_track_index:2},
        data.dashboard.tracks[2]
      ];
      data.dashboard.track_tree = [
        {track_index:0, children:[{track_index:2, children:[{track_index:1,children:[]}]}]},
        {track_index:-1000,children:[]}
      ];
      render();
    `, context);
    assert.equal(nodes.get('tracks').children.length, 2);
    let outer = nodes.get('tracks').children[0];
    assert.equal(outer.tagName, 'DETAILS');
    assert.equal(outer.open, true);
    assert.match(outer.children[0].children[1].textContent, /2 member tracks/);
    assert.equal(outer.children[1].children[1].children[0].open, false);
    outer.open = false;
    outer.ontoggle();
    vm.runInContext('renderTracks()', context);
    assert.equal(nodes.get('tracks').children[0].open, false, 'Collapse survives a redraw');
    nodes.get('expand-groups').onclick();
    outer = nodes.get('tracks').children[0];
    assert.equal(outer.open, true);
    assert.equal(outer.children[1].children[1].children[0].open, true);
    nodes.get('collapse-groups').onclick();
    assert.equal(nodes.get('tracks').children[0].open, false);
    nodes.get('track-layout').value = 'flat';
    nodes.get('track-layout').onchange();
    assert.equal(nodes.get('tracks').children.length, 4);
    assert.ok(nodes.get('tracks').children.every(n => n.tagName === 'ARTICLE'));
    nodes.get('track-layout').value = 'grouped';
    nodes.get('track-layout').onchange();
    assert.equal(nodes.get('tracks').children[0].open, false);
    assert.equal(vm.runInContext('trackPath(data.dashboard.tracks[2])', context), 'Outer / Nested / Kick');
    vm.runInContext("data.dashboard.session.session_instance_id = 'different-set'; renderTracks()", context);
    assert.equal(nodes.get('tracks').children[0].open, true, 'New sets do not inherit another set’s collapsed state');
    assert.equal(f.calls.length, callsBeforeGrouping, 'Grouping controls must never write to Ableton');
    vm.runInContext('data.dashboard.grouping_complete = false; renderTracks()', context);
    assert.equal(nodes.get('group-status').hidden, false);
    assert.match(nodes.get('group-status').textContent, /save your Set and restart Live/);
    assert.match(nodes.get('tracks').children[0].children[0].children[1].textContent, /membership incomplete/);
  }
});

test('track analyzer needs confirmation, refuses master and stays unloaded without stream support', async () => {
  const f = fixture();
  await f.creative.run({ action: 'scan' });
  await assert.rejects(f.creative.run({ action: 'trackAnalyzer', track_index: 0 }), /Confirm loading LivePilot_Analyzer on Pad/);
  await assert.rejects(f.creative.run({ action: 'trackAnalyzer', track_index: -1000, confirmed: true }), /master/);
  await assert.rejects(f.creative.run({ action: 'trackAnalyzer', track_index: 0, confirmed: true }), /Nothing was loaded.*Re-freeze/);
  assert.equal(f.devices.some(d => d.name === 'LivePilot_Analyzer'), false);
  assert.equal(f.calls.some(c => c.name === 'ensure_analyzer_on_master'), false);
});
test('track analyzer loads on the track and its stream report never touches solo or master spectrum', async () => {
  const f = fixture();
  f.analyzerStreams.supported = true;
  await f.creative.run({ action: 'scan' });
  const loaded = await f.creative.run({ action: 'trackAnalyzer', track_index: 0, confirmed: true });
  assert.equal(loaded.result.status, 'loaded');
  assert.equal(loaded.track_name, 'Pad');
  assert.ok(loaded.dashboard.tracks.find(t => t.index === 0).devices.some(d => d.name === 'LivePilot_Analyzer'));
  const measured = await f.creative.run({ action: 'trackStream', track_index: 0 });
  assert.equal(measured.report.mode, 'track analyzer stream');
  assert.equal(measured.report.spectrum.bands.sub, 0.6);
  assert.deepEqual(measured.report.loudness, { peak: 0.7, rms: 0.3 });
  assert.equal(f.calls.some(c => c.name === 'set_track_solo' || c.name === 'get_master_spectrum'), false);
});
test('isolated master analysis accepts track analyzers only when streams are separated', async () => {
  const f = fixture();
  f.devices.push({ index: 1, name: 'LivePilot_Analyzer' });
  await f.creative.run({ action: 'scan' });
  await f.creative.run({ action: 'inspect', track_index: 0 });
  await assert.rejects(f.creative.run({ action: 'isolated', track_index: 0, confirmed: true }), /cannot keep their streams separate/);
  f.analyzerStreams.supported = true;
  const data = await f.creative.run({ action: 'isolated', track_index: 0, confirmed: true });
  assert.equal(data.report.mode, 'isolated through master');
});
test('track window exposes separate track analyzer controls', async () => {
  const html = await readFile(new URL('./creative.html', import.meta.url), 'utf8');
  const client = await readFile(new URL('./creative-client.js', import.meta.url), 'utf8');
  assert.match(html, /id="track-analyzer">Load analyzer on this track/);
  assert.match(html, /id="track-stream"/);
  assert.match(client, /action\('trackAnalyzer', \{ track_index: selectedTrack, confirmed: true \}/);
  assert.doesNotMatch(client, /\$\('track-analyzer'\)\.onclick = \$\('ensure-analyzer'\)\.onclick/);
});
test('track analyzer explains an outdated MCP server instead of a raw unknown-tool error', async () => {
  const calls = [];
  const state = { session_instance_id: 'one', file_path: '/t.als', tempo: 120, is_playing: true, scene_count: 1, scenes: [],
    return_tracks: [], signature_numerator: 4, signature_denominator: 4, tracks: [{ index: 0, name: 'Pad', solo: false, mute: false }] };
  const creative = createCreative(async (name, args) => {
    calls.push(name);
    if (name === 'get_session_info') return structuredClone({ ...state, track_count: 1 });
    if (name === 'get_track_info') return { devices: [] };
    if (name === 'ensure_analyzer_on_track' || name === 'get_track_spectrum') throw new Error(`Unknown tool: '${name}'`);
    return {};
  }, { sleep: async () => {} });
  await creative.run({ action: 'scan' });
  await assert.rejects(creative.run({ action: 'trackAnalyzer', track_index: 0, confirmed: true }), /Restart the LivePilot MCP server/);
  await assert.rejects(creative.run({ action: 'trackStream', track_index: 0 }), /Restart the LivePilot MCP server/);
});
test('instrument plan lives in Creative direction with an All choice, not in Track analysis', async () => {
  const html = await readFile(new URL('./creative.html', import.meta.url), 'utf8');
  const direction = html.slice(html.indexOf('id="direction-section"'), html.indexOf('id="memory-title"'));
  const analysis = html.slice(html.indexOf('id="track-detail"'), html.indexOf('id="composer-section"'));
  assert.match(direction, /Existing-track instrument plan/);
  assert.match(direction, /<select id="instrument"><option value="all">All instruments and plug-ins on this track/);
  assert.doesNotMatch(analysis, /id="instrument"|Existing-track instrument plan|id="track-plan"/);
});
test('All instruments proposes branches across every device and applies to the branch device', async () => {
  const f = fixture();
  f.devices.push({ index: 1, name: 'Serum', class_name: 'PluginDevice' }, { index: 2, name: 'LivePilot_Analyzer' });
  await f.creative.run({ action: 'scan' });
  const { branches } = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 'all', mood: 'Warmth / comfort' });
  assert.equal(branches.device_index, 'all');
  assert.equal(branches.result.compiled_plans.length, 1);
  assert.equal(branches.result.compiled_plans[0].device_name, 'Wavetable');
  assert.match(branches.result.warnings.join(' '), /Serum: No synthesis adapter/);
  assert.equal(f.calls.filter(c => c.name === 'propose_synth_branches').length, 2);
  const data = await f.chooseBranch();
  assert.equal(data.plan.kind, 'track');
  assert.equal(data.plan.steps[0].blocked, null);
  assert.equal(data.plan.steps[0].params.device_index, 0);
});
test('focus suggestions can narrow the selected track to one instrument', async () => {
  const f = fixture();
  f.devices.push({ index: 1, name: 'Serum', class_name: 'PluginDevice' });
  await f.creative.run({ action: 'scan' });
  const data = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0], track_index: 0, device_index: 1 });
  const track = data.focus.tracks.find(t => t.index === 0);
  assert.deepEqual(track.devices.map(d => d.name), ['Serum']);
  const all = await f.creative.run({ action: 'focus', mood: 'Warmth / comfort', scope: 'tracks', track_indices: [0], track_index: 0, device_index: 'all' });
  assert.deepEqual(all.focus.tracks.find(t => t.index === 0).devices.map(d => d.name), ['Wavetable', 'Serum']);
});
test('unsupported MIDI effect uses exposed controls with verified reversible writes', async () => {
  const f = fixture();
  f.devices[0] = { index: 0, name: 'One Note Groove-1', class_name: 'MxDeviceMidiEffect' };
  f.synthFailures.set(0, "'One Note Groove-1' is not a supported native synth — synthesis_brain only knows about native synths");
  await f.creative.run({ action: 'scan' });
  const data = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0, mood: 'Warmth / comfort' });
  assert.equal(data.branches.result.compiled_plans.length, 0);
  assert.equal(data.focus.tracks[0].devices[0].name, 'One Note Groove-1');
  const parameter = data.focus.tracks[0].devices[0].parameters[0];
  assert.equal(parameter.value_string, '30%');
  assert.equal(parameter.min, 0);
  assert.equal(parameter.max, 1);
  assert.equal(f.calls.some(c => c.name === 'set_device_parameter'), false);
  const applied = await f.creative.run({ action: 'applyFocus', focus_id: data.focus.id, track_index: 0,
    device_index: 0, parameter_index: 0, reviewed_value: parameter.value, value: 0.4, confirmed: true });
  assert.equal(applied.changes[0].after_display, '40%');
  const bypassed = await f.creative.run({ action: 'recover', change_id: applied.changes[0].id, mode: 'bypass', confirmed: true });
  assert.equal(bypassed.changes[0].current_display, '30%');
});
test('All includes exposed plugin controls even with no native branches', async () => {
  const f = fixture();
  f.devices.push({ index: 1, name: 'Massive XL', class_name: 'PluginDevice' });
  f.synthFailures.set(0, "'Wavetable' is not a supported native synth");
  f.synthFailures.set(1, "'Massive XL' is not a supported native synth");
  await f.creative.run({ action: 'scan' });
  const data = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 'all' });
  assert.equal(data.branches.result.compiled_plans.length, 0);
  assert.deepEqual(data.focus.tracks[0].devices.map(d => d.name), ['Wavetable', 'Massive XL']);
  const single = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 1 });
  assert.deepEqual(single.focus.tracks[0].devices.map(d => d.name), ['Massive XL']);
});
test('unsupported-device warnings returned as data also use the exposed-control path', async () => {
  const f = fixture();
  f.synthWarnings.set(0, "'One Note Groove-1' is not a supported native synth — synthesis_brain only knows native synths");
  await f.creative.run({ action: 'scan' });
  const data = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
  assert.equal(data.focus.tracks[0].devices[0].parameters.length, 1);
  assert.match(data.branches.result.warnings[0], /using exposed device controls/);
  assert.doesNotMatch(data.branches.result.warnings[0], /is not a supported/);
});
test('unsupported devices explain missing configurable controls without inventing values', async () => {
  const f = fixture();
  f.synthFailures.set(0, "'Plugin' is not a supported native synth");
  f.parameterOverrides.is_read_only = true;
  await f.creative.run({ action: 'scan' });
  const data = await f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 });
  assert.equal(data.focus.tracks[0].devices[0].parameters.length, 0);
  assert.match(data.branches.result.warnings.join(' '), /Configure in Live/);
});
test('instrument control reads do not hide connection or native-planner failures', async () => {
  const f = fixture();
  await f.creative.run({ action: 'scan' });
  f.synthFailures.set(0, 'Connection lost');
  await assert.rejects(f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 'all' }), /Connection lost/);
  f.parameterFailures.set(0, 'Parameter read failed');
  await assert.rejects(f.creative.run({ action: 'trackPlan', track_index: 0, device_index: 0 }), /Parameter read failed/);
});
test('unsupported-device outcome renders editable controls inside Creative direction', async () => {
  const f = fixture();
  f.synthWarnings.set(0, "'One Note Groove-1' is not a supported native synth");
  await f.creative.run({ action: 'scan' });
  const { nodes, document } = browserDocument(await readFile(new URL('creative.html', import.meta.url), 'utf8'));
  const context = vm.createContext({ document, window: { name: '', confirm: () => true }, location: { pathname: '/track/0' },
    fetch: async (path, request) => ({ ok: true, json: async () => path === '/themes'
      ? { themes: [{ id: 'studio', name: 'Studio', scheme: 'dark', vars: {} }], selected: 'studio', warnings: [] }
      : path === '/ableton-status' ? { supported: true, running: true, installed: true }
      : path === '/creative' ? f.creative.run(JSON.parse(request.body)) : f.creative.snapshot() }),
  });
  vm.runInContext(await readFile(new URL('creative-client.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext("action('trackPlan', {track_index:0, device_index:0})", context);
  assert.match(nodes.get('outcome-title').textContent, /Proposal ready/);
  assert.match(nodes.get('outcome-body').textContent, /1 exposed controls ready/);
  const group = nodes.get('branches').children.find(n => n.tagName === 'DETAILS');
  assert.ok(group);
  assert.ok(group.children.some(n => n.className === 'knob-card'));
  assert.equal(f.calls.some(c => c.name === 'set_device_parameter'), false);
});
test('opening a track window reads and displays actual controls without generating settings', async () => {
  const f = fixture();
  const html = await readFile(new URL('creative.html', import.meta.url), 'utf8');
  const client = await readFile(new URL('creative-client.js', import.meta.url), 'utf8');
  const { nodes, document } = browserDocument(html);
  const context = vm.createContext({
    document,
    window: { name: '', confirm: () => true },
    location: { pathname: '/track/0' },
    fetch: async (path, request) => ({
      ok: true,
      json: async () => path === '/themes'
        ? { themes: [{ id: 'studio', name: 'Studio', scheme: 'dark', vars: {} }], selected: 'studio', warnings: [] }
        : path === '/ableton-status'
          ? { supported: true, running: true, installed: true }
          : path === '/creative-state'
            ? f.creative.snapshot()
            : f.creative.run(JSON.parse(request.body)),
    }),
  });
  vm.runInContext(client, context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const read = f.calls.find(c => c.name === 'get_device_parameters');
  assert.deepEqual(read.args, { track_index: 0, device_index: 0 });
  assert.equal(f.calls.some(c => c.name === 'propose_synth_branches'), false);
  assert.equal(f.calls.some(c => c.name === 'set_device_parameter'), false);
  const controlGroup = nodes.get('branches').children.find(node => node.tagName === 'DETAILS');
  assert.ok(controlGroup);
  assert.match(controlGroup.children[0].textContent, /1 configurable controls/);
  assert.equal(controlGroup.children[1].children[0].textContent, 'Brightness');
});
