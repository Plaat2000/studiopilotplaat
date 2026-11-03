const text = (name, label, required = false, value) => ({ name, label, type: 'string', required, value });
const integer = (name, label, value, min = 1, max = 100) => ({ name, label, type: 'integer', value, min, max });
const choice = (name, label, values, value) => ({ name, label, type: 'string', choices: values, value });
const tool = (name, label, description, fields = [], extra = {}) => ({ name, label, description, fields, ...extra });

export const modules = [
  { id: 'atlas', pillar: 'knowledge', title: 'Device Atlas', subtitle: 'Find the right sound',
    detail: '5,264 baseline devices / 120 enriched / 683 drum kits',
    tools: [
      tool('atlas_search', 'Search devices', 'Search instruments, effects, kits, and personal library entries.', [
        text('query', 'Sound or device', true), text('category', 'Category', false, 'all'), integer('limit', 'Results', 10),
      ]),
      tool('atlas_device_info', 'Device intelligence', 'Read a device profile, recipes, and parameter knowledge.', [text('device_id', 'Device ID', true)]),
      tool('atlas_chain_suggest', 'Suggest a chain', 'Suggest devices for a role; does not load them.', [text('role', 'Track role', true), text('genre', 'Genre')]),
      tool('atlas_techniques_for_device', 'Related techniques', 'Find techniques that reference a device.', [text('device_id', 'Device ID', true)]),
    ] },
  { id: 'samples', pillar: 'knowledge', title: 'Sample Engine', subtitle: 'Three sources, six fitness critics',
    detail: 'Splice local catalog / Ableton browser / filesystem',
    tools: [
      tool('search_samples', 'Find samples', 'Search enabled sources. No downloads or credit spending.', [
        text('query', 'Search query', true), text('material_type', 'Material type'), text('key', 'Musical key'),
        text('bpm_range', 'BPM range, e.g. 120-130'),
        choice('source', 'Source', ['', 'splice', 'browser', 'filesystem'], ''), integer('max_results', 'Results', 10),
      ]),
      tool('search_browser', 'Browse Ableton library', 'Search the installed Ableton browser without loading.', [
        text('path', 'Browser category', true, 'sounds'), text('name_filter', 'Name filter'),
        integer('max_results', 'Results', 20),
      ]),
      tool('suggest_sample_technique', 'Suggest processing', 'Rank techniques for a sample; no processing is applied.', [
        text('file_path', 'Sample file path', true),
        choice('intent', 'Intent', ['rhythm', 'texture', 'layer', 'melody', 'vocal', 'atmosphere', 'transform', 'challenge'], 'rhythm'),
        choice('philosophy', 'Philosophy', ['auto', 'surgeon', 'alchemist'], 'auto'),
      ]),
    ] },
  { id: 'analyzer', pillar: 'perception', title: 'M4L Analyzer', subtitle: 'Hear what is actually happening',
    detail: '9-band FFT / RMS + peak / pitch / key detection',
    tools: [
      tool('get_master_spectrum', '9-band spectrum', 'Read a master-bus snapshot. Requires fresh analyzer data.', [], { bridge: true }),
      tool('get_master_rms', 'RMS, peak & pitch', 'Read master levels and validated pitch tracking.', [], { bridge: true }),
      tool('get_detected_key', 'Detect musical key', 'Read accumulated key evidence; needs several bars of audio.', [], { bridge: true }),
      tool('get_spectral_shape', 'Spectral descriptors', 'Read centroid, spread, flatness, and more. Requires FluCoMa.', [], { bridge: true }),
      tool('get_capability_state', 'Check capabilities', 'Probe session, analyzer, and memory readiness.'),
    ] },
  { id: 'corpus', pillar: 'perception', title: 'Corpus Intelligence', subtitle: 'Turn knowledge into a method',
    detail: 'EmotionalRecipe / GenreChain / PhysicalModelRecipe / AutomationGesture',
    tools: [
      tool('consult_ableton_knowledge', 'Consult production knowledge', 'Build a consultation plan for relevant knowledge searches. This is a plan, not retrieved corpus evidence.', [
        text('question', 'Production question', true),
      ]),
      tool('corpus_status', 'User corpus status', 'Inspect indexed user knowledge sources; separate from bundled recipe structures.'),
    ] },
  { id: 'techniques', pillar: 'memory', title: 'Technique Memory', subtitle: 'Recall what worked',
    detail: 'Search by mood, genre, texture / stored patterns and chains',
    tools: [
      tool('memory_recall', 'Recall techniques', 'Search saved techniques by description.', [
        text('query', 'Mood, genre, texture, or phrase'), integer('limit', 'Results', 10),
      ]),
      tool('memory_list', 'Browse saved techniques', 'List persistent techniques without changing them.', [integer('limit', 'Results', 20)]),
      tool('memory_get', 'Inspect a technique', 'Read the complete stored payload.', [text('technique_id', 'Technique ID', true)]),
      tool('memory_replay', 'Prepare replay plan', 'Returns replay instructions, not automatic playback. Increments the saved replay counter.', [
        text('technique_id', 'Technique ID', true),
      ], { confirmation: 'This updates the technique replay counter and prepares instructions. It does not apply the technique to Ableton.' }),
    ] },
  { id: 'taste', pillar: 'memory', title: 'Taste Graph', subtitle: 'Your preferences, made visible',
    detail: 'Move preferences / device affinities / novelty tolerance',
    tools: [
      tool('get_taste_graph', 'Explore taste graph', 'Read inferred preferences, move families, and device affinities.'),
      tool('get_taste_dimensions', 'Preference dimensions', 'Read taste weights inferred from kept and undone moves.'),
      tool('get_anti_preferences', 'Avoid list', 'Read learned anti-preferences.'),
      tool('get_session_memory', 'Recent session memory', 'Read recent observations, hypotheses, and decisions.', [
        integer('limit', 'Entries', 10), text('category', 'Category'),
      ]),
    ] },
  { id: 'composer', pillar: 'memory', title: 'Composer Engine', subtitle: 'From intent to an executable plan',
    detail: 'Prompt / layers / processing / arrangement',
    tools: [
      tool('get_composition_plan', 'Preview composition', 'Preview layers and arrangement without execution or spending credits.', [text('prompt', 'Composition brief', true)]),
      tool('propose_composer_branches', 'Compare creative branches', 'Generate distinct compositional hypotheses; does not apply them.', [
        text('request_text', 'Composition brief', true), integer('count', 'Branches', 2, 1, 4),
      ]),
    ] },
];

export const discoveryTool = tool('search_tools', 'Search all MCP tools',
  'Discover commands outside the curated modules. Results are reference documentation, not automatically executed.',
  [text('query', 'Tool name or task', true)]);

export function getTool(name) {
  const found = [...modules.flatMap(m => m.tools), discoveryTool].find(t => t.name === name);
  if (!found) throw new Error('Choose a supported architecture command.');
  return found;
}

export function validateToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected command input.');
  const spec = getTool(input.name);
  const args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected command arguments.');
  if (spec.confirmation && input.confirmed !== true) throw new Error('Confirm the replay counter update first.');
  for (const key of Object.keys(args)) {
    if (!spec.fields.some(f => f.name === key)) throw new Error(`Unknown argument: ${key}`);
  }
  for (const field of spec.fields) {
    const value = args[field.name];
    if (value === undefined) {
      if (field.required) throw new Error(`${field.label} is required.`);
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string' || value.length > 8000 || (field.required && !value.trim())) {
        throw new Error(`${field.label} must be ${field.required ? 'non-empty ' : ''}text (max 8,000 characters).`);
      }
      if (field.choices && !field.choices.includes(value)) throw new Error(`Invalid ${field.label}.`);
    } else if (!Number.isInteger(value) || value < field.min || value > field.max) {
      throw new Error(`${field.label} must be an integer between ${field.min} and ${field.max}.`);
    }
  }
  return { spec, args };
}
