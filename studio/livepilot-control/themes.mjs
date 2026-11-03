import { readdir, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const FORMAT = 'livepilot-studio-appearance';
export const settingsDirectory = path.join(
  process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'),
  'extension-data', 'livepilot-control',
);

function luminance(hex) {
  const c = hex.slice(1, 7).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function readable(color, background) {
  if (contrast(color, background) >= 4.5) return color;
  return contrast('#ffffff', background) > contrast('#000000', background) ? '#ffffff' : '#000000';
}
export function parseTheme(xml, name, id) {
  if (!/<(?:Theme|SkinManager)(?:\s|>)/.test(xml)) throw new Error('Missing Ableton theme element.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Theme declarations and external entities are not supported.');
  const colors = {};
  for (const match of xml.matchAll(/<([A-Za-z][A-Za-z0-9]*)\s+Value=["'](#[0-9a-f]{6}(?:[0-9a-f]{2})?)["']\s*\/>/gi)) {
    colors[match[1]] = match[2].slice(0, 7).toLowerCase();
  }
  for (const match of xml.matchAll(/<([A-Za-z][A-Za-z0-9]*)>\s*<R Value="(\d+)"\s*\/>\s*<G Value="(\d+)"\s*\/>\s*<B Value="(\d+)"\s*\/>(?:\s*<Alpha Value="\d+"\s*\/>)?\s*<\/\1>/g)) {
    const rgb = match.slice(2, 5).map(Number);
    if (rgb.some(v => v > 255)) throw new Error(`Invalid RGB color: ${match[1]}`);
    colors[match[1]] = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  if (!colors.Desktop) throw new Error('Missing theme color: Desktop');
  const foreground = colors.ControlForeground || colors.RetroDisplayForeground || colors.ControlTextBack;
  const control = colors.ControlBackground || colors.SurfaceBackground || colors.DetailViewBackground;
  if (!foreground || !control) throw new Error('Missing theme colors for controls.');
  const background = colors.Desktop;
  const surface = colors.DetailViewBackground || colors.SurfaceBackground || colors.ControlBackground;
  const text = readable(foreground, background);
  const surfaceText = readable(foreground, surface);
  const accent = colors.ChosenDefault || colors.RangeDefault || text;
  const vars = {
    '--background': background, '--surface': surface, '--control': control,
    '--text': text,     '--surface-text': surfaceText, '--control-text': readable(foreground, control),
    '--muted': text, '--surface-muted': surfaceText,
    '--border': colors.SelectionFrame || colors.ControlSelectionFrame || colors.SurfaceHighlight || text,
    '--hover': colors.SurfaceHighlight || surface,
    '--accent': readable(accent, background), '--accent-fill': accent, '--on-accent': readable(text, accent),
    '--focus': readable(accent, surface), '--knowledge': readable(accent, control),
    '--perception': readable(colors.ChosenAlternative || accent, control),
    '--memory': readable(colors.ChosenPreListen || accent, control),
    '--error': readable(colors.ChosenRecord || colors.Alert || '#ff595f', surface),
    '--warning': readable(colors.ChosenAlert || accent, surface),
  };
  return { id, name, scheme: luminance(background) > 0.35 ? 'light' : 'dark', vars,
    adapted: !colors.ControlForeground || !colors.ControlBackground };
}

function validateSettings(value) {
  if (!value || value.format !== FORMAT || value.version !== 1 ||
      !Array.isArray(value.directories) || !value.directories.every(p => typeof p === 'string' && path.isAbsolute(p)) ||
      typeof value.selected !== 'string') throw new Error('Unrecognized or corrupt LivePilot appearance settings.');
  return value;
}
export function createThemeStore(directory = settingsDirectory) {
  const file = path.join(directory, 'appearance.json');
  let queue = Promise.resolve();
  const serial = fn => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  async function settings() {
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { format: FORMAT, version: 1, directories: [], selected: 'studio' };
      throw error;
    }
    return validateSettings(JSON.parse(raw));
  }
  async function save(value) {
    validateSettings(value);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `appearance-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  }
  async function catalog() {
    const config = await settings();
    const themes = [
      { id: 'studio', name: 'Countryside Creative Studio (original)', scheme: 'dark', vars: {} },
      { id: 'countryside', name: 'Countryside', scheme: 'dark', vars: { '--backdrop-image': "url('/background.png')" } },
    ];
    const warnings = [];
    for (const source of config.directories) {
      let entries;
      try { entries = await readdir(source, { withFileTypes: true }); }
      catch (error) { warnings.push(`Cannot read theme directory ${source}: ${error.message}`); continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || entry.name.startsWith('.') || !/\.ask$/i.test(entry.name)) continue;
        const sourceFile = path.join(source, entry.name);
        const id = createHash('sha256').update(sourceFile).digest('hex').slice(0, 24);
        try {
          const xml = await readFile(sourceFile, 'utf8');
          if (xml.length > 2000000) throw new Error('Theme exceeds 2 MB.');
          themes.push(parseTheme(xml, entry.name.replace(/\.ask$/i, ''), id));
        } catch (error) { warnings.push(`${entry.name}: ${error.message}`); }
      }
    }
    if (!themes.some(theme => theme.id === config.selected)) {
      warnings.push('The saved theme is no longer installed. Showing the original Studio palette.');
    }
    return { themes, selected: themes.some(theme => theme.id === config.selected) ? config.selected : 'studio', warnings };
  }
  return {
    catalog: () => serial(catalog),
    configure: directories => serial(async () => {
      if (!Array.isArray(directories) || directories.length > 20 ||
          !directories.every(p => typeof p === 'string' && path.isAbsolute(p))) {
        throw new Error('Provide up to 20 absolute theme-directory paths.');
      }
      const current = await settings();
      await save({ ...current, directories: [...new Set(directories)] });
    }),
    select: id => serial(async () => {
      const available = await catalog();
      if (!available.themes.some(theme => theme.id === id)) throw new Error('Theme is not installed.');
      const current = await settings();
      await save({ ...current, selected: id });
      return { ...available, selected: id };
    }),
  };
}
