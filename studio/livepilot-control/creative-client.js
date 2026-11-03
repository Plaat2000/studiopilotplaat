'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name=livepilot-token]').content;
const isTrackWindow = /^\/track(?:\/-?\d+)?$/.test(location.pathname);
const trackMatch = /^\/track\/(-?\d+)$/.exec(location.pathname) || /^livepilot-track-(-?\d+)$/.exec(window.name);
const selectedTrack = isTrackWindow && trackMatch ? Number(trackMatch[1]) : null;
let data = {};
let busy = false;
let abletonApp = null;
let launchingAbleton = false;
let themes;
let themeKeys = [];
let intelligenceTab = 'corpus';
let loopDirty = false;
let trackLayout = 'grouped';
let groupSession = '';
const groupOpen = new Map();
const directionFields = ['mood', 'texture', 'suggestion', 'preferences'];
const directionDraft = {};
let focusScope = selectedTrack === null ? '' : 'tracks';
let focusSession = '';
const focusTracks = new Set(selectedTrack === null ? [] : [selectedTrack]);
const knobDrafts = new Map();
const manualKnobs = new Set();
const directionChoices = {
  mood: [
    ['Tension / anxiety', 'Rising resonance, detuning, dissonance and rhythmic gaps.'],
    ['Warmth / comfort', 'Gentle harmonics, soft attacks and slow filter movement.'],
    ['Nostalgia', 'Reduced brightness, subtle pitch instability and saturation.'],
    ['Vastness / awe', 'Long tails, stereo space and sustained low foundations.'],
    ['Aggression / impact', 'Pitch envelopes, bright distortion and faster modulation.'],
    ['Melancholy / sadness', 'Minor harmony, sparse layers, slow attacks and dark echoes.'],
    ['Euphoria / release', 'Opening filters, harmonic richness and bright spaciousness.'],
  ],
  texture: [
    ['Water / liquid', 'Slow chorus, dispersed grains and spectral blur.'],
    ['Metal', 'Inharmonic resonance, FM and resonators.'],
    ['Glass / crystalline', 'High-ratio FM, sharp partials and diffusion.'],
    ['Breath / air', 'Filtered noise, moving bandpass and envelope following.'],
    ['Fire / heat', 'Unstable feedback, modulated drive and scattered grains.'],
    ['Electricity', 'Ring modulation, buzzing harmonics and fast modulation.'],
    ['Organic / evolving', 'Subtle pitch drift, filter breathing and irregular automation.'],
    ['Granular / fragmented', 'Micro-fragments, stretching and differentiated layers.'],
  ],
};
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('livepilot-creative-studio') : null;

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function direction() {
  return { ...Object.fromEntries(directionFields.map(key => [key, $(key).value])),
    ...(selectedTrack === null ? {} : { track_index: selectedTrack }) };
}
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function button(label, fn) {
  const node = text('button', label);
  node.onclick = fn;
  return node;
}
async function post(path, input = {}) {
  const response = await fetch(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LivePilot-Token': token },
    body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'LivePilot request failed.');
  return result;
}
async function work(fn, label = 'Reading live evidence...') {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button,input,textarea,select')];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  status(label);
  try { const message = await fn(); status(message || 'Ready. No changes applied by this read.'); }
  catch (error) {
    status(error.message, true);
    $('warnings-section').hidden = false;
    $('warnings').textContent = error.message;
  } finally {
    controls.forEach((control, i) => { if (control.isConnected) control.disabled = disabled[i]; });
    if (themes) $('theme-selector').disabled = false;
    busy = false;
    renderAbletonApp();
  }
}
function renderAbletonApp() {
  $('live-transport').disabled = busy || abletonApp?.running !== true;
  $('ableton-launch').disabled = busy || !abletonApp?.supported || abletonApp.running || !abletonApp.installed;
  $('ableton-launch').title = abletonApp?.running ? 'Ableton Live is already running' : 'Start Ableton Live';
  if (!abletonApp) return;
  $('ableton-app-status').textContent = launchingAbleton ? 'Starting Ableton Live...' :
    !abletonApp.supported ? abletonApp.message :
    abletonApp.running ? 'Ableton Live is running' :
    abletonApp.installed ? 'Ableton is not running. Click the Studio title to start it.' : 'Ableton Live is not installed.';
}
async function checkAbletonApp() {
  try { abletonApp = await post('/ableton-status'); }
  catch (error) {
    abletonApp = null;
    $('ableton-app-status').textContent = error.message;
    throw error;
  }
  renderAbletonApp();
  return abletonApp;
}
async function readCreativeSession() {
  data = await post('/creative', { action: 'scan' });
  if (selectedTrack !== null) data = await post('/creative', { action: 'inspect', track_index: selectedTrack });
  if (selectedTrack !== null) data = await post('/creative', {
    action: 'trackPlan', track_index: selectedTrack, device_index: 'all', controls_only: true,
  });
  if (data.intent) {
    for (const key of directionFields) setDirectionValue(key, directionDraft[key] ?? data.intent[key] ?? '');
  }
  render();
}
async function refreshAbletonSession() {
  await work(async () => {
    const current = await checkAbletonApp();
    if (!current.supported) throw new Error(current.message);
    if (!current.running) return current.installed ?
      'Ableton is not running. Click Countryside Creative Studio above to start it.' : 'Install Ableton Live before connecting.';
    await readCreativeSession();
  }, 'Checking Ableton and refreshing live evidence...');
}
async function launchAbleton() {
  await work(async () => {
    launchingAbleton = true;
    renderAbletonApp();
    try {
      abletonApp = await post('/ableton-launch', { confirmed: true });
      for (let attempt = 0; !abletonApp.running && attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await checkAbletonApp();
      }
      if (!abletonApp.running) throw new Error('Ableton launch was requested, but it has not appeared during the startup checks. Check Live, then use Refresh all tracks to check again.');
      launchingAbleton = false;
      renderAbletonApp();
      try { await readCreativeSession(); }
      catch (error) {
        throw new Error(`Ableton is running, but Studio could not read its session yet: ${error.message}. Wait for Live to finish opening, then click Refresh all tracks.`);
      }
      return 'Ableton is running and its session is loaded. Playback and device settings were not changed.';
    } finally { launchingAbleton = false; }
  }, 'Starting Ableton Live...');
}
async function action(name, input = {}, message) {
  await work(async () => {
    let result;
    try { result = await post('/creative', { action: name, ...input }); }
    catch (error) {
      if (['execute', 'recover', 'applyFocus'].includes(name)) {
        try { data = await post('/creative-state'); }
        catch (refreshError) { throw new Error(`${error.message} Could not refresh execution state: ${refreshError.message}`); }
        render();
        channel?.postMessage({ type: 'updated' });
      }
      showOutcome('Request failed — inspect the result', error.message +
        (['execute', 'recover', 'applyFocus', 'transport', 'analyzer', 'trackAnalyzer', 'isolated'].includes(name) ?
          ' A control request may have reached Ableton. Check its current state before continuing.' :
          ' No execution step was approved by this request.'));
      throw error;
    }
    if (name === 'design') {
      $('report-result').textContent = JSON.stringify(result, null, 2);
      $('report-scope').textContent = result.notice;
      $('report-summary').replaceChildren(readable(result.result));
    } else {
      data = result;
      if (['knowledge', 'focus', 'compose', 'trackPlan', 'direction'].includes(name)) {
        for (const key of directionFields) {
          if (directionDraft[key] === input[key]) delete directionDraft[key];
        }
      }
      if (name === 'transport' && input.command === 'loop') loopDirty = false;
      render();
      channel?.postMessage({ type: 'updated' });
    }
    return actionOutcome(name, input, result);
  }, message);
}
function details(label, value) {
  const node = document.createElement('details');
  node.append(text('summary', label), text('pre', JSON.stringify(value, null, 2)));
  return node;
}
function goal() {
  const intent = data.plan?.intent || data.intent || {};
  const parts = [intent.mood && `Mood: ${intent.mood}`, intent.texture && `Texture: ${intent.texture}`,
    intent.suggestion && `Your suggestion: ${intent.suggestion}`,
    intent.preferences && `Keep in mind: ${intent.preferences}`].filter(Boolean);
  return parts.length ? `Intended direction — ${parts.join('. ')}. This is a goal, not a verified listening result.` :
    'No audible improvement has been measured. Listen before deciding to keep this change.';
}
function stepSummary(step, kind = data.plan?.kind) {
  const args = step.applied_arguments || step.params || step.arguments || {};
  const isNew = kind === 'composer' && !step.applied_arguments && args.track_index !== undefined;
  const track = isNew ? null : data.dashboard?.tracks.find(t => t.index === args.track_index);
  const scope = isNew ? 'New layer (not an existing track)' :
    track?.name || (typeof args.track_index === 'number' ? `Track ${args.track_index + 1}` : data.plan?.scope || 'Session');
  const device = track?.devices?.find(d => d.index === args.device_index);
  const parameter = device?.parameters?.find(p => p.index === args.parameter_index || p.name === args.parameter_name);
  switch (step.tool) {
    case 'set_device_parameter': return `${scope}: adjust ${device?.name || 'instrument'} / ${parameter?.name || args.parameter_name || `parameter ${args.parameter_index}`} to ${step.verified_value ?? args.value}.`;
    case 'set_tempo': return `Whole session: set tempo to ${args.tempo} BPM. This affects every track.`;
    case 'create_midi_track': return 'Add a new MIDI layer. Existing tracks will not be replaced.';
    case 'create_audio_track': return 'Add a new audio layer. Existing tracks will not be replaced.';
    case 'set_track_name': return `Name the new layer "${args.name}".`;
    case 'create_scene': return 'Add a new Session scene for the new layers.';
    case 'set_scene_name': return `Name the new scene "${args.name}".`;
    case 'create_clip': return `${scope}: create a MIDI clip${args.length ? ` of ${args.length} beats` : ''}.`;
    case 'set_clip_name': return `${scope}: name the clip "${args.name}".`;
    case 'add_notes': return `${scope}: add ${Array.isArray(args.notes) ? args.notes.length : 'the planned'} notes to the clip.`;
    case 'insert_device': return `${scope}: load the planned instrument or effect.`;
    case 'load_sample_to_simpler': return `${scope}: load a sample into Simpler.`;
    case 'set_track_volume': return `${scope}: set volume to ${args.volume} (raw 0–1 scale).`;
    case 'set_track_pan': return `${scope}: set pan to ${args.pan} (-1 left, +1 right).`;
    case 'set_track_send': return `${scope}: set send ${args.send_index + 1} to ${args.value} (raw scale).`;
    default: return step.description || 'Unsupported step — no changes can be applied here.';
  }
}
function showOutcome(title, message, change) {
  $('outcome-title').textContent = title;
  $('outcome-body').textContent = message;
  $('outcome-changes').replaceChildren(...(change ? [changeCard(change)] : []));
  $('last-outcome').hidden = false;
  $('last-outcome').textContent = `${title}. ${message}`;
  if (!$('outcome-dialog').open) $('outcome-dialog').showModal();
}
function actionOutcome(name, input, result) {
  let title, message, change;
  if (name === 'execute') {
    const step = data.plan.steps[input.step_index];
    change = data.changes?.find(c => c.id === step.change_id);
    title = change ? 'Applied — setting verified in Ableton' : 'Applied — step completed';
    message = change ? `${change.track_name}: ${change.label} changed from ${change.before_display} to ${change.after_display}.` : stepSummary(step);
    message += ` ${goal()} ${data.plan.next} of ${data.plan.steps.length} steps applied.`;
    if (!change) message += ' This structural/content step has no safe automatic bypass or revert in Studio; no global Undo will be issued.';
  } else if (name === 'applyFocus') {
    change = data.changes.find(c => c.id === data.focus?.tracks.find(t => t.index === input.track_index)?.devices
      .find(d => d.index === input.device_index)?.parameters.find(p => p.index === input.parameter_index)?.change_id);
    title = 'Applied and verified — listen before keeping';
    message = `${change.track_name}: ${change.label} changed from ${change.before_display} to ${change.after_display}. ` +
      'Only this knob changed. Use Bypass to compare with the saved before setting; no audible improvement is assumed.';
  } else if (name === 'focus') {
    title = 'Ideas ready — nothing applied';
    message = `${data.focus.tracks.length} tracks considered for ${data.focus.scope === 'song' ? 'the whole song' : 'your selection'}. ` +
      'Read the ideas below Session Map. Adopt an idea locally, adjust its target, then Apply this knob when ready.';
  } else if (name === 'recover') {
    change = data.changes.find(c => c.id === input.change_id);
    title = { bypass: 'Bypassed — original setting restored', enable: 'Re-enabled — applied setting restored', revert: 'Reverted — original setting restored' }[input.mode];
    message = `${change.track_name}: ${change.label} is now ${change.current_display}, verified in Ableton. ` +
      (input.mode === 'revert' ? 'This saved change is closed; other settings are untouched.' : 'Use the toggle to compare before and after. Other settings are untouched.');
  } else if (['compose', 'chooseBranch', 'trackPlan'].includes(name)) {
    title = 'Proposal ready — nothing applied';
    message = name === 'trackPlan' ? `${data.branches.track_name}: ${data.branches.result.compiled_plans.length} native-synth alternatives and ` +
      `${data.focus.tracks.flatMap(t => t.devices).reduce((count, d) => count + d.parameters.length, 0)} exposed controls ready in Creative direction. ` +
      'Adjust a draft and approve each knob, or review a native-synth option. ' + data.branches.result.warnings.join(' ') :
      `${data.plan.steps.length} proposed steps for ${data.plan.scope}. ${data.plan.kind === 'composer' ? 'These add new layers, not rewrite existing tracks.' : 'These adjust only the chosen instrument.'} Review and apply a step to change Ableton.`;
    if (data.plan?.status === 'needs_sources' && name !== 'trackPlan') {
      title = 'Plan blocked — nothing applied';
      message = data.plan.notice;
    }
  } else if (name === 'knowledge' || name === 'design') {
    title = 'Advice ready — nothing applied';
    message = name === 'knowledge' ?
      `${data.guidance?.ranked?.length || 0} tracks considered. These are suggestions, not edits. Use “Where to focus next” below Session Map for scoped ideas and adjustable knobs.` :
      `Device-state suggestions are ready. ${result.notice} No instrument or effect settings were changed.`;
  } else if (name === 'trackAnalyzer') {
    const loaded = data.result?.status === 'loaded';
    title = loaded ? `Analyzer added to ${data.track_name}` : `${data.track_name} already has an analyzer`;
    message = `${loaded ? 'LivePilot_Analyzer was loaded as the last device on this track.' :
      'No device was added.'} Its readings stay separate from the master analyzer. ` +
      (data.result?.is_last_on_track === false ? 'It is not the last device, so it reads the signal before the devices after it. ' : '') +
      'Use "Measure this track\'s analyzer" while the track plays. Remove the device in Ableton to undo.';
  } else if (['offline', 'isolated', 'analyzer', 'trackStream'].includes(name)) {
    title = name === 'analyzer' ? 'Analyzer request completed' : 'Analysis ready — no creative changes applied';
    message = name === 'analyzer' ? 'The master analyzer setup was checked. This does not apply the requested creative direction.' :
      `${data.report?.scope || 'Measurement complete.'} ${name === 'isolated' ? 'Temporary solo settings have been restored.' : 'Playback and device settings were not changed.'}`;
  } else if (name === 'transport') {
    return input.command === 'loop' ? 'Loop settings verified in Ableton.' :
      input.command === 'start' ? 'Playback started in Ableton.' : 'Playback stopped in Ableton.';
  } else return;
  showOutcome(title, message, change);
  return title;
}
function changeCard(change) {
  const card = document.createElement('article');
  card.className = 'outcome-card';
  card.dataset.state = change.state;
  card.append(text('h3', `${change.track_name} / ${change.label}`),
    text('p', `Before: ${change.before_display} → After: ${change.after_display ?? 'not verified'}`),
    text('p', { active: 'Applied — after setting is active.', bypassed: 'Bypassed — original setting is active.',
      reverted: 'Reverted — original setting restored; saved change closed.',
      uncertain: 'Uncertain — inspect Ableton. Automatic recovery is disabled.' }[change.state]));
  if (change.error) card.append(text('p', change.error, 'blocked'));
  if (change.state === 'active' || change.state === 'bypassed') {
    const controls = document.createElement('div');
    controls.className = 'row';
    const recover = mode => {
      if (mode === 'revert' && !window.confirm(`Permanently restore the original ${change.label} on ${change.track_name}? This closes this saved change and stops any remaining steps in its plan. Other settings are untouched.`)) return;
      action('recover', { change_id: change.id, mode, confirmed: true }, 'Restoring and verifying the saved setting...');
    };
    const toggle = button(change.state === 'active' ? 'Bypass / hear before' : 'Re-enable / hear after',
      () => recover(change.state === 'active' ? 'bypass' : 'enable'));
    toggle.setAttribute('aria-pressed', String(change.state === 'bypassed'));
    controls.append(toggle, button('Revert this change', () => recover('revert')));
    card.append(controls);
  }
  return card;
}
function applyTheme(id) {
  const theme = themes.themes.find(t => t.id === id);
  if (!theme) throw new Error('Theme no longer installed.');
  themeKeys.forEach(key => document.documentElement.style.removeProperty(key));
  themeKeys = Object.keys(theme.vars);
  for (const [key, value] of Object.entries(theme.vars)) document.documentElement.style.setProperty(key, value);
  document.documentElement.style.colorScheme = theme.scheme;
  $('theme-selector').value = id;
  $('theme-selector').disabled = false;
}
function renderThemes(result) {
  themes = result;
  $('theme-selector').replaceChildren(...result.themes.map(t => {
    const option = text('option', t.name);
    option.value = t.id;
    return option;
  }));
  applyTheme(result.selected);
  $('theme-status').textContent = `${result.themes.length - 2} installed Ableton palettes.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`;
}
function openTrack(index) {
  const popup = window.open(`/track/${index}`, `livepilot-track-${index}`, 'popup,width=1080,height=900');
  if (!popup) status('The browser blocked the track window. Allow popups for this local panel.', true);
}
function configureTrackWindow() {
  if (selectedTrack === null) return;
  document.body.classList.add('track-window');
  const layout = $('studio-layout');
  layout.insertBefore($('direction-section'), $('advice-section'));
  layout.insertBefore($('track-detail'), $('advice-section'));
  $('refresh').textContent = 'Refresh track context';
  $('advise').textContent = 'Develop this track / scope below';
  $('instrument-plan').hidden = false;
}
function instrumentChoice() {
  const value = $('instrument').value;
  return value === '' || value === 'all' ? 'all' : Number(value);
}
async function readTrackControls() {
  if (selectedTrack === null) return;
  data = await post('/creative', {
    action: 'trackPlan', track_index: selectedTrack, device_index: instrumentChoice(), controls_only: true,
  });
  render();
}
function render() {
  const dashboard = data.dashboard;
  if (!dashboard) return;
  $('studio-layout').insertBefore($('composer-section'),
    dashboard.is_blank === true && !isTrackWindow ? $('track-section') : $('warnings-section'));
  for (const key of directionFields) {
    if (document.activeElement !== $(key)) setDirectionValue(key, directionDraft[key] ?? data.intent?.[key] ?? '');
  }
  renderDirectionInsights();
  $('session-state').textContent = `${dashboard.session.is_playing ? 'Playing' : 'Stopped'} / ${dashboard.session.tempo} BPM / ${dashboard.session.track_count} tracks / ${new Date(dashboard.timestamp).toLocaleTimeString()}`;
  renderTransport(dashboard.session);
  if (selectedTrack !== null) {
    document.body.classList.add('track-window');
    const track = dashboard.tracks.find(t => t.index === selectedTrack);
    const path = track ? trackPath(track) : 'Track no longer exists';
    document.title = `${path} — Countryside Creative Studio`;
    $('detail-title').textContent = track ? `${track.name} / Track analysis` : 'Track no longer exists';
    $('scope-label').textContent = track ? `Creative context: ${trackPath(track)}` : 'Refresh the session map.';
    $('intelligence-scope').textContent = track ? track.name : 'Missing track';
    $('track-detail').hidden = false;
    const clips = track?.clip_slots?.filter(c => c.has_clip) || [];
    const oldClip = $('clip').value;
    $('clip').replaceChildren(text('option', 'Select a Session audio clip'));
    $('clip').firstChild.value = '';
    for (const clip of clips) {
      const option = text('option', `Slot ${clip.index + 1} (audio only)`);
      option.value = clip.index;
      $('clip').append(option);
    }
    if (clips.some(c => String(c.index) === oldClip)) $('clip').value = oldClip;
    const oldDevice = $('instrument').value;
    $('instrument').replaceChildren(text('option', 'All instruments and plug-ins on this track'));
    $('instrument').firstChild.value = 'all';
    for (const device of (track?.devices || []).filter(d => d.name !== 'LivePilot_Analyzer')) {
      const option = text('option', device.name);
      option.value = device.index;
      $('instrument').append(option);
    }
    $('instrument').value = track?.devices?.some(d => String(d.index) === oldDevice && d.name !== 'LivePilot_Analyzer') ? oldDevice : 'all';
    renderReport(data.reports?.[selectedTrack]);
  }
  renderTracks();
  renderFocusScope();
  renderIntelligence();
  renderAdvice();
  renderPlan();
  $('applied-changes').replaceChildren(...(data.changes || []).map(changeCard));
  renderBranches();
  const warnings = [...dashboard.warnings, ...(data.guidance?.warnings || []), ...(data.focus?.warnings || []),
    ...(data.plan?.source?.warnings || [])];
  $('warnings-section').hidden = warnings.length === 0;
  $('warnings').textContent = warnings.join('\n');
}
function setDirectionValue(key, value) {
  if (Object.hasOwn(directionChoices, key) && value && ![...$(key).children].some(option => option.value === value)) {
    const option = text('option', `${value} (saved custom direction)`);
    option.value = value;
    $(key).append(option);
  }
  $(key).value = value;
}
function renderDirectionInsights() {
  for (const key of ['mood', 'texture']) {
    const choice = directionChoices[key].find(([label]) => label === $(key).value);
    $(`${key}-insight`).textContent = choice ? choice[1] :
      $(key).value ? 'Custom direction; use Your own suggestion to explain the intended result.' :
        `Choose a ${key}, or leave this unselected and describe your own direction below.`;
  }
}
function trackPath(track) {
  const names = [track.name];
  const seen = new Set([track.index]);
  let parent = data.dashboard.tracks.find(t => t.index === track.group_track_index);
  while (parent && !seen.has(parent.index)) {
    names.unshift(parent.name);
    seen.add(parent.index);
    parent = data.dashboard.tracks.find(t => t.index === parent.group_track_index);
  }
  return names.join(' / ');
}
function trackCard(track) {
  const card = document.createElement('article');
  card.className = 'track-card';
  card.dataset.trackIndex = String(track.index);
  card.dataset.muted = String(Boolean(track.mute));
  card.dataset.master = String(Boolean(track.master));
  card.append(text('h3', track.name));
  card.append(text('p', `${track.master ? 'Master' : track.index < 0 ? 'Return' : track.is_foldable ? 'Group bus' : track.has_midi_input ? 'MIDI' : 'Audio'}${track.mute ? ' / muted' : ''}${track.solo ? ' / solo' : ''}`));
  card.append(text('p', (track.devices || []).map(d => d.name).join(' / ') || 'No devices'));
  if (typeof track.meter?.level === 'number') {
    const meter = document.createElement('meter');
    meter.className = 'meter'; meter.min = 0; meter.max = 1; meter.value = track.meter.level;
    meter.setAttribute('aria-label', `${track.name} output peak`);
    card.append(meter, text('p', `${track.meter.is_playing ? 'Output peak snapshot' : 'Stopped / peak-hold, not current audio'}: ${track.meter.level.toFixed(3)}`));
  } else card.append(text('p', 'No meter reading'));
  const controls = document.createElement('div');
  controls.className = 'row';
  controls.append(button(track.is_foldable ? 'M4L / group bus analysis' : 'M4L / track analysis', () => openTrack(track.index)));
  card.append(controls);
  return card;
}
function renderTracks() {
  const dashboard = data.dashboard;
  if (!dashboard) {
    $('group-status').hidden = false;
    $('group-status').textContent = 'No session loaded. Start Ableton and refresh to see its tracks.';
    return;
  }
  const sessionKey = JSON.stringify([dashboard.session.session_instance_id, dashboard.session.file_path]);
  if (groupSession !== sessionKey) { groupOpen.clear(); groupSession = sessionKey; }
  const tracks = new Map(dashboard.tracks.map(track => [track.index, track]));
  const tree = dashboard.track_tree || dashboard.tracks.map(t => ({ track_index: t.index, children: [] }));
  $('group-status').hidden = dashboard.grouping_complete !== false;
  $('group-status').textContent = dashboard.grouping_complete === false ?
    'Group membership is incomplete; affected tracks remain separate. Update the Remote Script and call reload_handlers. If Live still serves old handlers, save your Set and restart Live, then refresh Studio.' : '';
  const members = node => node.children.reduce((count, child) => count + 1 + members(child), 0);
  function branch(node) {
    const track = tracks.get(node.track_index);
    if (!track.is_foldable || track.index < 0) return trackCard(track);
    const group = document.createElement('details');
    group.className = 'track-group';
    group.dataset.groupIndex = String(track.index);
    const key = `${track.index}:${track.name}`;
    group.open = groupOpen.get(key) ?? !track.fold_state;
    const summary = document.createElement('summary');
    summary.append(text('span', track.name, 'group-name'), text('span', dashboard.grouping_complete === false ?
      'Group / membership incomplete' : `Group / ${members(node)} member tracks`, 'scope-badge'));
    const content = document.createElement('div');
    content.className = 'group-content';
    content.append(trackCard(track));
    const children = document.createElement('div');
    children.className = 'track-grid group-members';
    children.append(...node.children.map(branch));
    content.append(children);
    group.append(summary, content);
    group.ontoggle = () => { if (group.isConnected) groupOpen.set(key, group.open); };
    return group;
  }
  $('track-layout').value = trackLayout;
  $('tracks').replaceChildren(...(trackLayout === 'flat' ? dashboard.tracks.map(trackCard) : tree.map(branch)));
}
function expandGroups(open) {
  for (const track of data.dashboard?.tracks || []) {
    if (track.is_foldable && track.index >= 0) groupOpen.set(`${track.index}:${track.name}`, open);
  }
  renderTracks();
}
function renderTransport(session) {
  $('transport-loop').textContent = session.loop ? 'Loop on' : 'Loop off';
  $('transport-loop').setAttribute('aria-pressed', String(Boolean(session.loop)));
  const beatsPerBar = session.signature_numerator * 4 / session.signature_denominator;
  const valid = Number.isFinite(beatsPerBar) && beatsPerBar > 0;
  if (!loopDirty && valid && Number.isFinite(session.loop_start) && Number.isFinite(session.loop_length)) {
    $('loop-start').value = String(1 + session.loop_start / beatsPerBar);
    $('loop-end').value = String(1 + (session.loop_start + session.loop_length) / beatsPerBar);
  }
  $('transport-state').textContent = `${session.is_playing ? 'Playing' : 'Stopped'}${valid ? ` / ${session.signature_numerator}/${session.signature_denominator}` : ' / Time signature unavailable'}`;
}
function renderReport(report) {
  if (!report) {
    $('report-scope').textContent = 'No current report for this track.';
    $('report-result').textContent = 'Choose an analysis mode.';
    $('spectrum').replaceChildren();
    $('report-summary').replaceChildren();
    return;
  }
  $('report-scope').textContent = `${report.mode} / ${new Date(report.timestamp).toLocaleTimeString()} / ${report.scope}`;
  $('report-result').textContent = JSON.stringify(report, null, 2);
  $('spectrum').replaceChildren();
  const bands = report.spectrum?.bands || report.spectrum?.band_balance;
  if (bands && typeof bands === 'object') {
    for (const [name, value] of Object.entries(bands)) {
      if (typeof value !== 'number') continue;
      const column = document.createElement('div');
      column.className = 'band';
      const bar = document.createElement('div');
      bar.className = 'bar'; bar.style.height = `${Math.max(2, Math.min(1, value) * 110)}px`;
      column.append(bar, text('span', `${name}: ${value.toFixed(3)}`));
      $('spectrum').append(column);
    }
  }
  $('report-summary').replaceChildren();
  for (const [key, value] of Object.entries(report.loudness || {})) {
    if (typeof value === 'number' || typeof value === 'string') $('report-summary').append(text('span', `${key}: ${value}`, 'result-chip'));
  }
}
function renderIntelligence() {
  const guidance = data.guidance;
  if (!guidance) { $('intelligence-view').hidden = true; return; }
  $('intelligence-view').hidden = false;
  $('intelligence-heading').textContent = { corpus: 'Corpus Intelligence', memory: 'Technique Memory', taste: 'Taste Graph' }[intelligenceTab];
  $('intelligence-notice').textContent = guidance.notice;
  const summaries = {
    corpus: 'Corpus provides a research/consultation plan for your direction. It does not apply track changes.',
    memory: 'Technique Memory recalls saved methods. Recalled methods are not automatically applied.',
    taste: `Taste Graph has ${guidance.taste?.evidence_count || 0} preference observations. It informs suggestions; it does not edit your tracks.`,
  };
  $('intelligence-summary').replaceChildren(text('p', summaries[intelligenceTab]),
    readable(guidance[intelligenceTab]),
    text('p', 'See the track-by-track recommendations in “Where to focus next”.'));
  $('intelligence-result').textContent = JSON.stringify(guidance[intelligenceTab] ?? { notice: 'Unavailable; see warnings.' }, null, 2);
}
function readable(value, depth = 0) {
  const list = document.createElement('ul');
  if (depth > 3 || value == null) return list;
  if (typeof value !== 'object') { list.append(text('li', String(value))); return list; }
  const entries = Array.isArray(value) ? value.slice(0, 12).map((v, i) => [String(i), v]) :
    Object.entries(value).filter(([key]) =>
      !/^(id|uuid|tool|params|arguments|track_index|device_index|parameter_index|timestamp|generated_at|raw|source)$/i.test(key)).slice(0, 12);
  for (const [key, item] of entries) {
    if (item == null || typeof item === 'boolean') continue;
    const entry = document.createElement('li');
    const label = Array.isArray(value) ? '' : `${key.replaceAll('_', ' ')}: `;
    if (typeof item === 'object') entry.append(text('span', label), readable(item, depth + 1));
    else entry.textContent = `${label}${item}`;
    list.append(entry);
  }
  return list;
}
function renderAdvice() {
  if (data.focus) {
    const tracks = selectedTrack !== null && focusScope !== 'song' ?
      data.focus.tracks.filter(track => focusTracks.has(track.index)) : data.focus.tracks;
    $('advice-notice').textContent = tracks.length ?
      `Generated for ${data.focus.scope === 'song' ? 'the whole song' : 'selected tracks'} (${tracks.length} tracks shown). ${data.focus.notice} Direction: ${Object.values(data.focus.intent).filter(Boolean).join(' / ')}. Read at ${new Date(data.focus.timestamp).toLocaleTimeString()}.` :
      'No ideas for this track yet. Choose a creative direction, then suggest ideas and read its real knobs.';
    $('advice-list').replaceChildren();
    for (const track of tracks) {
      const card = text('article', '', 'advice-card');
      card.append(text('h3', track.name));
      for (const advice of track.advice.advice) card.append(text('p', `${advice.reason} ${advice.action}`),
        text('small', `Basis: ${advice.basis}`));
      if (!track.devices.length) card.append(text('p', 'No writable exposed device knobs were found. Nothing was added or changed.', 'muted'));
      for (const device of track.devices) {
        const group = text('div', '', 'focus-device');
        group.append(text('h4', `${track.name} / ${device.name}`));
        const suggested = device.parameters.filter(p => p.suggestion).slice(0, 3);
        const controls = text('div', '', 'focus-knobs');
        for (const p of device.parameters) {
          if (suggested.includes(p) || manualKnobs.has(knobKey(track, device, p))) controls.append(knobControl(track, device, p));
        }
        if (!suggested.length) group.append(text('p', 'No reliable named-knob match for this direction. Choose a real exposed control below rather than guessing.', 'muted'));
        const label = text('label', 'Explore another exposed knob');
        const select = document.createElement('select');
        select.setAttribute('aria-label', `${track.name} / ${device.name}: choose an exposed knob`);
        const empty = text('option', 'Choose a knob to explore manually');
        empty.value = '';
        select.append(empty);
        for (const p of device.parameters) {
          const option = text('option', p.name);
          option.value = p.index;
          select.append(option);
        }
        select.onchange = () => {
          if (select.value === '') return;
          const p = device.parameters.find(p => p.index === Number(select.value));
          if (!p) return;
          const key = knobKey(track, device, p);
          if (!suggested.includes(p) && !manualKnobs.has(key)) {
            manualKnobs.add(key);
            controls.append(knobControl(track, device, p));
          }
        };
        label.append(select);
        group.append(label, controls);
        card.append(group);
      }
      card.append(button('Open track evidence', () => openTrack(track.index)));
      $('advice-list').append(card);
    }
    return;
  }
  const guidance = data.guidance;
  if (!guidance) {
    $('advice-list').replaceChildren();
    $('advice-notice').textContent = 'Set a creative direction and choose a scope to see ideas with adjustable device controls.';
    return;
  }
  $('advice-notice').textContent = guidance.notice;
  $('advice-list').replaceChildren();
  const entries = selectedTrack === null ? guidance.ranked : guidance.ranked.filter(t => t.track_index === selectedTrack);
  for (const item of entries) {
    const card = document.createElement('article');
    card.className = 'advice-card';
    card.append(text('h3', `${item.track_name} / priority ${item.priority}`),
      text('small', `Likely role: ${item.role} (${item.role_source})`));
    const list = document.createElement('ul');
    for (const advice of item.advice) {
      const entry = text('li', `${advice.reason} ${advice.action}`);
      entry.append(text('small', `Basis: ${advice.basis}`));
      list.append(entry);
    }
    card.append(list, button('Open track evidence', () => openTrack(item.track_index)));
    $('advice-list').append(card);
  }
}
function renderFocusScope() {
  if (!data.dashboard) {
    $('focus-track-picker').hidden = focusScope !== 'tracks';
    $('focus-tracks').replaceChildren(text('p', 'Connect Ableton to choose tracks.'));
    return;
  }
  const sessionKey = JSON.stringify([data.dashboard.session.session_instance_id, data.dashboard.session.file_path]);
  if (focusSession && focusSession !== sessionKey) {
    focusTracks.clear();
    focusScope = selectedTrack === null ? '' : 'tracks';
    if (selectedTrack !== null) focusTracks.add(selectedTrack);
    knobDrafts.clear();
    manualKnobs.clear();
  }
  focusSession = sessionKey;
  for (const index of focusTracks) if (!data.dashboard.tracks.some(t => t.index === index)) focusTracks.delete(index);
  $('focus-scope').value = focusScope;
  $('focus-track-picker').hidden = focusScope !== 'tracks';
  $('focus-tracks').replaceChildren();
  for (const track of data.dashboard.tracks) {
    const label = text('label', '', 'focus-track-choice');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = focusTracks.has(track.index);
    input.onchange = () => {
      if (input.checked) focusTracks.add(track.index);
      else focusTracks.delete(track.index);
      renderAdvice();
    };
    label.append(input, text('span', trackPath(track)));
    $('focus-tracks').append(label);
  }
}
function knobKey(track, device, parameter) {
  return `${data.focus.id}/${track.index}/${device.index}/${parameter.index}`;
}
function knobControl(track, device, parameter) {
  const key = knobKey(track, device, parameter);
  const card = text('article', '', 'knob-card');
  card.append(text('h5', parameter.name),
    text('p', `Current in Ableton: ${parameter.value_string ?? parameter.value} (raw ${parameter.value})`));
  if (parameter.suggestion) card.append(text('p', parameter.suggestion.reason),
    text('small', parameter.suggestion.basis));
  else card.append(text('p', 'Manual exploration of a real exposed knob. No creative target was inferred.', 'muted'));
  const previous = knobDrafts.get(key);
  const initial = previous?.reviewed_value === parameter.value ? previous.value : parameter.value;
  const range = document.createElement('input');
  range.type = 'range';
  const value = document.createElement('input');
  value.type = 'number';
  for (const input of [range, value]) {
    input.min = parameter.min;
    input.max = parameter.max;
    input.step = parameter.is_quantized ? '1' : 'any';
    input.value = initial;
    input.setAttribute('aria-label', `${track.name} / ${device.name} / ${parameter.name}: target raw value${input === range ? ' slider' : ''}`);
  }
  const notice = text('p', 'Draft only — move the slider or adopt the idea, then Apply this knob.', 'muted');
  const apply = button('Apply this knob', () => {
    if (!value.reportValidity()) return;
    const target = Number(value.value);
    if (!window.confirm(`Change only ${track.name} / ${device.name} / ${parameter.name}?\nCurrent: ${parameter.value_string ?? parameter.value}. Target: ${target} (raw value).\nThe result will be read back; Bypass/Revert will remain available.`)) return;
    action('applyFocus', { focus_id: data.focus.id, track_index: track.index, device_index: device.index,
      parameter_index: parameter.index, reviewed_value: parameter.value, value: target, confirmed: true },
    'Applying and verifying one approved knob...');
  });
  const change = data.changes?.find(c => c.id === parameter.change_id);
  function draft(next) {
    range.value = value.value = next;
    const target = Number(next);
    const valid = next !== '' && Number.isFinite(target) && target >= parameter.min && target <= parameter.max &&
      (!parameter.is_quantized || Number.isInteger(target));
    knobDrafts.set(key, { value: next, reviewed_value: parameter.value });
    apply.disabled = !valid || target === parameter.value || change?.state === 'uncertain';
    notice.textContent = valid ? `Draft target: ${next} (raw range ${parameter.min} to ${parameter.max}). Not applied.` : 'Choose a valid target inside the exposed range.';
  }
  range.oninput = () => draft(range.value);
  value.oninput = () => draft(value.value);
  draft(String(initial));
  const controls = text('div', '', 'row');
  if (parameter.suggestion) controls.append(button('Adopt idea (draft only)', () => draft(String(parameter.suggestion.value))));
  controls.append(apply);
  card.append(range, value, notice, controls);
  if (change) card.append(changeCard(change));
  return card;
}
function requestFocus() {
  if (!focusScope || (focusScope === 'tracks' && !focusTracks.size)) {
    status('Choose the whole song or select one or more tracks in Where to focus next.', true);
    $('focus-scope').focus();
    return;
  }
  action('focus', { ...direction(), scope: focusScope, track_indices: [...focusTracks],
    ...(selectedTrack === null ? {} : { device_index: instrumentChoice() }) }, 'Reading real device knobs for your chosen scope...');
}
function renderPlan() {
  const plan = data.plan;
  if (!plan) {
    $('plan-steps').replaceChildren();
    $('plan-progress').textContent = 'No plan';
    $('plan-source').textContent = 'No plan generated.';
    $('plan-notice').textContent = 'No plan yet. Advice does not change tracks. Generate a plan, then approve its steps to apply changes.';
    return;
  }
  $('plan-notice').textContent = `${plan.notice} ${goal()}`;
  $('plan-progress').textContent = `${plan.next}/${plan.steps.length} applied / ${plan.status}`;
  $('plan-source').textContent = JSON.stringify(plan.source, null, 2);
  $('plan-steps').replaceChildren();
  for (const step of plan.steps) {
    const card = document.createElement('article');
    card.className = 'plan-step'; card.dataset.state = step.state;
    const change = data.changes?.find(c => c.id === step.change_id);
    const state = change?.state || step.state;
    card.append(text('h3', `${step.index + 1}. ${stepSummary(step)}`),
      text('p', { pending: 'Proposal only — not applied', done: 'Applied', active: 'Applied and verified',
        bypassed: 'Bypassed — original setting active', reverted: 'Reverted', uncertain: 'Uncertain — inspect Ableton' }[state] || state),
      details('Technical step details', { tool: step.tool, arguments: step.applied_arguments || step.params || step.arguments || {} }));
    if (step.blocked || step.error) card.append(text('p', step.blocked || step.error, 'blocked'));
    if (!['set_device_parameter', 'set_tempo', 'set_track_volume', 'set_track_pan', 'set_track_send'].includes(step.tool)) {
      card.append(text('p', 'Content/layout change: safe automatic bypass and revert are not available for this step.', 'muted'));
    }
    if (step.verified_value !== undefined) card.append(text('p', `Verified in Ableton: ${step.verified_value}`));
    const approve = button('Apply this step', () => {
      if (!window.confirm(`Apply this change in Ableton?\n${stepSummary(step)}\nOnly this step will run.`)) return;
      action('execute', { plan_id: plan.id, step_index: step.index, confirmed: true }, 'Executing approved step...');
    });
    approve.disabled = step.index !== plan.next || Boolean(step.blocked) || ['uncertain', 'reverted'].includes(plan.status) ||
      data.changes?.some(c => c.plan_id === plan.id && ['bypassed', 'uncertain'].includes(c.state));
    card.append(approve);
    $('plan-steps').append(card);
  }
}
function renderBranches() {
  $('branches').replaceChildren();
  if (selectedTrack === null || data.branches?.track_index !== selectedTrack) return;
  const branches = data.branches.result;
  for (const warning of branches.warnings || []) $('branches').append(text('p', warning, 'warning'));
  if (data.focus?.id === data.branches.focus_id) {
    $('branches').append(text('p', data.focus.notice, 'muted'));
    for (const track of data.focus.tracks) {
      for (const device of track.devices) {
        const group = document.createElement('details');
        group.append(text('summary', `${device.name} / ${device.parameters.length} configurable controls`));
        if (!device.parameters.length) group.append(text('p', 'No editable controls exposed. In Ableton, use the plug-in Configure button to expose parameters, then request the plan again.', 'warning'));
        for (const parameter of device.parameters) group.append(knobControl(track, device, parameter));
        $('branches').append(group);
      }
    }
  } else {
    $('branches').append(text('p', 'Device controls changed with newer suggestions. Request this instrument plan again to refresh its controls.', 'muted'));
  }
  for (const [index, compiled] of (branches.compiled_plans || []).entries()) {
    const card = document.createElement('article');
    card.className = 'plan-step';
    card.append(text('h3', compiled.summary || branches.seeds?.[index]?.label || `Option ${index + 1}`),
      text('p', `${data.branches.track_name} / ${compiled.device_name || data.branches.device_name}: ${compiled.steps.length} proposed instrument adjustments. Nothing applied.`));
    const list = document.createElement('ul');
    for (const step of compiled.steps) list.append(text('li', stepSummary(step, 'track')));
    card.append(list, details('Technical branch details', compiled.steps),
      button('Review this option', () => action('chooseBranch', { branch_id: data.branches.id, branch_index: index })));
    $('branches').append(card);
  }
}
function knowledge(tab) {
  intelligenceTab = tab;
  action('knowledge', direction(), 'Reading Corpus, Technique Memory, and Taste Graph...');
}
$('corpus').onclick = () => knowledge('corpus');
$('outcome-close').onclick = () => $('outcome-dialog').close();
for (const key of ['mood', 'texture']) {
  const empty = text('option', `No preset ${key} / my own direction`);
  empty.value = '';
  $(key).replaceChildren(empty, ...directionChoices[key].map(([label]) => {
    const option = text('option', label);
    option.value = label;
    return option;
  }));
}
for (const key of directionFields) {
  const update = () => { directionDraft[key] = $(key).value; renderDirectionInsights(); };
  $(key).oninput = update;
  $(key).onchange = update;
}
$('track-layout').onchange = () => { trackLayout = $('track-layout').value; renderTracks(); };
$('expand-groups').onclick = () => expandGroups(true);
$('collapse-groups').onclick = () => expandGroups(false);
$('transport-start').onclick = () => action('transport', { command: 'start' }, 'Starting playback...');
$('transport-stop').onclick = () => action('transport', { command: 'stop' }, 'Stopping playback...');
for (const id of ['loop-start', 'loop-end']) $(id).oninput = () => { loopDirty = true; };
function loopInput(enabled) {
  if (!$('loop-start').reportValidity() || !$('loop-end').reportValidity()) return;
  const start = Number($('loop-start').value), end = Number($('loop-end').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end <= start) {
    status('Choose a start bar of at least 1 and a later end bar (exclusive).', true);
    return;
  }
  action('transport', { command: 'loop', enabled, start_bar: start, end_bar: end }, 'Setting and verifying the loop...');
}
$('transport-loop').onclick = () => {
  if (data.dashboard?.session.loop) action('transport', { command: 'loop', enabled: false }, 'Disabling the loop...');
  else loopInput(true);
};
$('loop-apply').onclick = () => loopInput(Boolean(data.dashboard?.session.loop));
$('techniques').onclick = () => knowledge('memory');
$('taste').onclick = () => knowledge('taste');
$('focus-scope').onchange = () => { focusScope = $('focus-scope').value; renderFocusScope(); renderAdvice(); };
$('focus-suggest').onclick = requestFocus;
$('advise').onclick = requestFocus;
$('compose').onclick = () => action('compose', direction(), 'Composer is compiling a reviewable plan...');
$('refresh').onclick = refreshAbletonSession;
$('ableton-launch').onclick = launchAbleton;
$('inspect-track').onclick = () => action('inspect', { track_index: selectedTrack });
$('design').onclick = () => action('design', { track_index: selectedTrack });
$('offline').onclick = () => {
  if ($('clip').value === '') { status('Choose an occupied Session audio clip slot.', true); return; }
  action('offline', { track_index: selectedTrack, clip_index: Number($('clip').value) });
};
$('isolated').onclick = () => action('isolated',
  { track_index: selectedTrack, confirmed: $('solo-confirm').checked },
  'Measuring through master; temporary solos will be restored...');
$('ensure-analyzer').onclick = () => {
  if (window.confirm('Ensure one analyzer is loaded LAST on master? No analyzers will be installed on individual tracks.')) {
    action('analyzer', { confirmed: true });
  }
};
$('track-analyzer').onclick = () => {
  const name = data.dashboard?.tracks?.find(t => t.index === selectedTrack)?.name || 'this track';
  if (selectedTrack === null || selectedTrack === -1000) { $('ensure-analyzer').onclick(); return; }
  if (window.confirm(`Load LivePilot_Analyzer as the LAST device on ${name}? Its readings stay separate from master. Remove it in Ableton to undo.`)) {
    action('trackAnalyzer', { track_index: selectedTrack, confirmed: true }, `Loading the analyzer on ${name}...`);
  }
};
$('track-stream').onclick = () => action('trackStream', { track_index: selectedTrack },
  'Reading this track\'s own analyzer for one second...');
$('theme-selector').onchange = () => work(async () => renderThemes(await post('/theme', { id: $('theme-selector').value })));
for (const name of ['brightness', 'warmth', 'movement', 'softness', 'width', 'texture_density']) {
  const wrapper = document.createElement('div');
  const label = text('label', `${name.replace('_', ' ')} / relative direction`);
  label.htmlFor = `target-${name}`;
  const input = document.createElement('input');
  Object.assign(input, { id: label.htmlFor, type: 'number', min: -1, max: 1, step: 0.1, value: 0 });
  wrapper.append(label, input);
  $('timbre-targets').append(wrapper);
}
$('track-plan').onclick = () => {
  const target = {};
  for (const name of ['brightness', 'warmth', 'movement', 'softness', 'width', 'texture_density']) {
    const input = $(`target-${name}`);
    if (!input.reportValidity()) return;
    target[name] = Number(input.value);
  }
  action('trackPlan', { ...direction(), device_index: instrumentChoice(), target });
};
$('instrument').onchange = () => work(readTrackControls, 'Reading actual exposed controls from Ableton...');
if (channel) channel.onmessage = event => {
  if (event.data?.type !== 'updated' || busy) return;
  work(async () => { data = await post('/creative-state'); render(); });
};
async function initialize() {
  await work(async () => {
    const current = await checkAbletonApp();
    renderThemes(await post('/themes'));
    if (!current.supported) throw new Error(current.message);
    if (!current.running) return current.installed ?
      'Ableton is not running. Click Countryside Creative Studio above to start it.' : 'Install Ableton Live before connecting.';
    data = await post('/creative-state');
    if (!data.dashboard) data = await post('/creative', { action: 'scan' });
    if (selectedTrack !== null) {
      data = await post('/creative', { action: 'inspect', track_index: selectedTrack });
      data = await post('/creative', {
        action: 'trackPlan', track_index: selectedTrack, device_index: 'all', controls_only: true,
      });
    }
    if (data.intent) {
      for (const key of directionFields) setDirectionValue(key, data.intent[key] || '');
    }
    render();
  });
}
configureTrackWindow();
if (isTrackWindow && selectedTrack === null) status('Open track windows from a track card on the main dashboard.', true);
else initialize();
