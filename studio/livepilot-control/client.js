'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name=livepilot-token]').content;
let state;
let busy = false;
let trackIndex = '';
let deviceIndex = '';
let catalog;
let selectedModule = 'atlas';
let selectedCommand = 'atlas_search';
let themeCatalog;
let themeVariables = [];
function applyTheme(id) {
  const theme = themeCatalog.themes.find(item => item.id === id);
  if (!theme) throw new Error('Selected theme is unavailable.');
  for (const key of themeVariables) document.documentElement.style.removeProperty(key);
  themeVariables = Object.keys(theme.vars);
  for (const [key, value] of Object.entries(theme.vars)) document.documentElement.style.setProperty(key, value);
  document.documentElement.style.colorScheme = theme.scheme;
  $('theme-selector').value = theme.id;
}
function renderThemes(data) {
  themeCatalog = data;
  $('theme-selector').replaceChildren(...data.themes.map(theme => option(theme.id, theme.name)));
  $('theme-selector').disabled = false;
  applyTheme(data.selected);
  const selected = data.themes.find(theme => theme.id === data.selected);
  $('theme-status').textContent = `${data.themes.length - 2} installed Ableton themes / applies to this panel only.${selected.adapted ? ' Partial theme: missing control colors adapted from its palette.' : ''}${data.warnings.length ? ` ${data.warnings.join(' ')}` : ''}`;
}
function message(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
async function request(path, input = {}) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button,input,select')];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  message('Working...');
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LivePilot-Token': token },
      body: JSON.stringify(input),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'LivePilot request failed.');
    controls.forEach((control, i) => { if (control.isConnected) control.disabled = disabled[i]; });
    if (path === '/themes' || path === '/theme') {
      renderThemes(data);
      message('Theme ready.');
    } else if (path === '/catalog') {
      catalog = data;
      renderModules();
      renderCommandOptions();
      message('Architecture modules ready.');
    } else if (path === '/query') {
      renderResult(data);
      message(`${data.tool} completed.`);
    } else {
      state = data;
      render();
      $('remote-state').textContent = `Connected / Live ${state.session.live_version || '12'} / last refreshed ${new Date().toLocaleTimeString()}`;
      message('Connected. Live values loaded.');
    }
    return true;
  } catch (error) {
    controls.forEach((control, i) => { if (control.isConnected) control.disabled = disabled[i]; });
    message(error.message, true);
    if (path === '/themes' || path === '/theme') {
      $('theme-status').textContent = `Theme error: ${error.message}`;
      if (themeCatalog) $('theme-selector').value = themeCatalog.selected;
    }
    if (path === '/catalog') $('module-result').textContent = `Module initialization failed: ${error.message}. Reload the panel to retry.`;
    return false;
  } finally { busy = false; }
}
function option(value, text) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = text;
  return item;
}
function button(text, fn, pressed) {
  const item = document.createElement('button');
  item.textContent = text;
  item.onclick = fn;
  if (pressed !== undefined) item.setAttribute('aria-pressed', String(pressed));
  return item;
}
function edit(command, value, extra = {}) {
  return request('/command', {
    command, value, track_index: Number(trackIndex), track_name: state.track?.name, ...extra,
  });
}
function rangeControl({ parent, id, label, value, min, max, step, display, change, disabled = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'parameter';
  const title = document.createElement('label');
  title.htmlFor = id;
  title.textContent = `${label}  `;
  const output = document.createElement('output');
  output.textContent = display ?? String(value);
  title.append(output);
  const row = document.createElement('div');
  row.className = 'row';
  const slider = document.createElement('input');
  Object.assign(slider, { type: 'range', id, min, max, step, value, disabled });
  slider.setAttribute('aria-label', label);
  const numeric = document.createElement('input');
  Object.assign(numeric, { type: 'number', min, max, step, value, disabled });
  numeric.setAttribute('aria-label', `${label} raw value`);
  slider.oninput = () => { numeric.value = slider.value; output.textContent = `${slider.value} (not applied)`; };
  slider.onchange = () => change(Number(slider.value));
  numeric.oninput = () => { slider.value = numeric.value; };
  const apply = button('Apply', () => {
    if (numeric.reportValidity()) change(Number(numeric.value));
  });
  apply.disabled = disabled;
  row.append(slider, numeric, apply);
  const bounds = document.createElement('div');
  bounds.className = 'bounds';
  bounds.textContent = `Raw range ${min} to ${max}${step === 1 ? ' / discrete steps' : ''}`;
  wrap.append(title, row, bounds);
  parent.append(wrap);
}
function render() {
  document.querySelectorAll('#transport-title ~ button, [data-command], #refresh, #tempo-form input, #tempo-form button, #filter')
    .forEach(el => { el.disabled = false; });
  const session = state.session;
  $('session-summary').textContent = `${session.is_playing ? 'Playing' : 'Stopped'} / ${session.tempo} BPM / ${session.signature_numerator}/${session.signature_denominator} / ${session.track_count} tracks`;
  $('tempo').value = session.tempo;
  const tracks = [
    ...session.tracks,
    ...(session.return_tracks || []).map((t, i) => ({ ...t, index: -i - 1 })),
    { index: -1000, name: 'Master' },
  ];
  trackIndex = state.track && tracks.some(t => t.index === state.track.index)
    ? String(state.track.index) : '';
  deviceIndex = trackIndex !== '' && state.parameters ? String(state.parameters.device_index) : '';
  $('track').replaceChildren(option('', 'Select a track'), ...tracks.map(t => option(String(t.index), t.name)));
  $('track').value = trackIndex;
  $('track').disabled = false;
  $('mixer').replaceChildren();
  $('device').replaceChildren(option('', 'Select a device'));
  $('device').disabled = !state.track;
  if (state.track && trackIndex !== '') {
    const t = state.track;
    const row = document.createElement('div');
    row.className = 'row';
    if (Number(trackIndex) >= 0) {
      row.append(button(t.mute ? 'Unmute' : 'Mute', () => edit('set_track_mute', !t.mute), t.mute));
      row.append(button(t.solo ? 'Unsolo' : 'Solo', () => edit('set_track_solo', !t.solo), t.solo));
    }
    $('mixer').append(row);
    if (Number(trackIndex) !== -1000 && typeof t.mixer?.volume === 'number') {
      rangeControl({ parent: $('mixer'), id: 'volume', label: 'Volume', value: t.mixer.volume, min: 0, max: 1,
        step: 'any', change: value => edit('set_track_volume', value) });
      rangeControl({ parent: $('mixer'), id: 'pan', label: 'Pan / left -1, center 0, right 1', value: t.mixer.panning,
        min: -1, max: 1, step: 'any', change: value => edit('set_track_pan', value) });
    }
    for (const d of t.devices || []) $('device').append(option(String(d.index), d.name));
  }
  if (!state.parameters) deviceIndex = '';
  $('device').value = deviceIndex;
  renderParameters();
}

    function allTools() {
      return [...catalog.modules.flatMap(module => module.tools), catalog.discoveryTool];
    }
    function currentTool() {
      return allTools().find(tool => tool.name === selectedCommand);
    }
    function renderModules() {
      for (const pillar of ['knowledge', 'perception', 'memory']) $(`${pillar}-modules`).replaceChildren();
      for (const module of catalog.modules) {
        const card = button('', () => {
          selectedModule = module.id;
          selectedCommand = module.tools[0].name;
          renderModules();
          renderCommandOptions();
          $('workspace-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, module.id === selectedModule);
        card.className = 'module-card';
        card.setAttribute('aria-label', module.title);
        const title = document.createElement('strong');
        title.textContent = module.title;
        const subtitle = document.createElement('span');
        subtitle.textContent = module.subtitle;
        const detail = document.createElement('small');
        detail.textContent = module.detail;
        card.append(title, subtitle, detail);
        $(`${module.pillar}-modules`).append(card);
      }
    }
    function renderCommandOptions() {
      const module = catalog.modules.find(item => item.id === selectedModule);
      const commands = module ? module.tools : [catalog.discoveryTool];
      $('workspace-title').textContent = module ? `${module.title} / Commands` : 'MCP tool discovery';
      $('module-command').replaceChildren(...commands.map(tool => option(tool.name, tool.label)));
      $('module-command').value = selectedCommand;
      $('module-command').disabled = false;
      $('run-module').disabled = false;
      renderCommandFields();
    }
    function renderCommandFields() {
      const spec = currentTool();
      $('command-description').textContent = spec.description;
      $('command-fields').replaceChildren();
      for (const field of spec.fields) {
        const wrap = document.createElement('div');
        wrap.className = 'field';
        const label = document.createElement('label');
        label.htmlFor = `argument-${field.name}`;
        label.textContent = `${field.label}${field.required ? ' *' : ''}`;
        const input = document.createElement(field.choices ? 'select' : 'input');
        input.id = label.htmlFor;
        input.name = field.name;
        if (field.choices) input.append(...field.choices.map(value => option(value, value || 'All / automatic')));
        else {
          input.type = field.type === 'integer' ? 'number' : 'text';
          if (field.type === 'integer') {
            input.min = field.min;
            input.max = field.max;
            input.step = '1';
          } else input.maxLength = 8000;
        }
        input.required = Boolean(field.required);
        input.value = field.value ?? '';
        wrap.append(label, input);
        $('command-fields').append(wrap);
      }
      $('command-warning').hidden = !spec.bridge && !spec.confirmation;
      $('command-warning').textContent = spec.confirmation || 'Requires the optional M4L analyzer and fresh audio data. Missing or stale data will be reported, not simulated.';
      $('confirmation-label').hidden = !spec.confirmation;
      $('command-confirmation').checked = false;
      $('command-confirmation').required = Boolean(spec.confirmation);
      $('run-module').textContent = spec.confirmation ? 'Prepare replay plan' : spec.bridge ? 'Read analyzer' : 'Run command';
    }
    function renderResult(result) {
      $('result-title').textContent = result.tool;
      $('result-time').textContent = new Date(result.timestamp).toLocaleTimeString();
      $('module-result').textContent = JSON.stringify(result.data, null, 2);
      $('result-summary').replaceChildren();
      const addChip = text => {
        const chip = document.createElement('span');
        chip.className = 'result-chip';
        chip.textContent = text;
        $('result-summary').append(chip);
      };
      for (const [key, value] of Object.entries(result.data)) {
        if (Array.isArray(value)) addChip(`${key}: ${value.length}`);
        else if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length < 65)) {
          addChip(`${key}: ${value}`);
        }
      }
      const capability = result.data.capability_state;
      if (capability?.domains) {
        const analyzer = capability.domains.analyzer;
        const remote = capability.domains.session_access;
        $('bridge-state').textContent = analyzer
          ? `${analyzer.available ? 'Ready' : analyzer.device_loaded ? 'Loaded / no fresh data' : 'Unavailable'}${analyzer.reasons?.length ? ` / ${analyzer.reasons.join(', ')}` : ''}`
          : 'Analyzer state not reported';
        $('remote-state').textContent = remote ? `${remote.available ? 'Connected' : 'Unavailable'} / ${remote.mode}` : 'Session state not reported';
        addChip(`mode: ${capability.overall_mode}`);
      }
    }
function renderParameters() {
  $('parameters').replaceChildren();
  const parameters = state?.parameters;
  if (!parameters) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = state?.track?.devices?.length === 0 ? 'This track has no devices.' : 'Select a device to read its actual parameter ranges.';
    $('parameters').append(note);
    return;
  }
  const term = $('filter').value.toLowerCase();
  const items = parameters.items.filter(p => p.name.toLowerCase().includes(term));
  if (!items.length) $('parameters').textContent = 'No matching parameters.';
  for (const p of items) {
    rangeControl({ parent: $('parameters'), id: `parameter-${p.index}`, label: p.name, value: p.value,
      min: p.min, max: p.max, step: p.is_quantized ? 1 : 'any', display: p.value_string,
      disabled: p.is_enabled === false || p.min === p.max,
      change: value => edit('set_device_parameter', value, {
        device_index: Number(deviceIndex), device_name: parameters.device_name, parameter_index: p.index,
      }),
    });
  }
}
$('refresh').onclick = () => request('/refresh');
document.querySelectorAll('[data-command]').forEach(el => {
  el.onclick = () => request('/command', { command: el.dataset.command });
});
$('tempo-form').onsubmit = event => {
  event.preventDefault();
  request('/command', { command: 'set_tempo', value: Number($('tempo').value) });
};
$('track').onchange = () => {
  trackIndex = $('track').value;
  deviceIndex = '';
  if (trackIndex === '') { state.track = null; state.parameters = null; render(); return; }
  request('/inspect', { track_index: Number(trackIndex) });
};
$('device').onchange = () => {
  deviceIndex = $('device').value;
  if (deviceIndex === '') { state.parameters = null; renderParameters(); return; }
  request('/inspect', { track_index: Number(trackIndex), device_index: Number(deviceIndex) });
};
$('filter').oninput = renderParameters;
$('theme-selector').onchange = () => request('/theme', { id: $('theme-selector').value });
$('refresh-themes').onclick = () => request('/themes');
$('module-command').onchange = () => {
  selectedCommand = $('module-command').value;
  renderCommandFields();
};
$('discover').onclick = () => {
  if (!catalog) return;
  selectedModule = 'discovery';
  selectedCommand = catalog.discoveryTool.name;
  renderModules();
  renderCommandOptions();
};
$('check-capabilities').onclick = () => request('/query', { name: 'get_capability_state', arguments: {} });
$('module-form').onsubmit = event => {
  event.preventDefault();
  if (!catalog) return;
  const args = {};
  for (const field of currentTool().fields) {
    const raw = $(`argument-${field.name}`).value;
    if (raw !== '') args[field.name] = field.type === 'integer' ? Number(raw) : raw;
  }
  request('/query', { name: selectedCommand, arguments: args, confirmed: $('command-confirmation').checked });
};
async function initialize() {
  await request('/themes');
  if (await request('/catalog')) await request('/refresh');
}
initialize();
