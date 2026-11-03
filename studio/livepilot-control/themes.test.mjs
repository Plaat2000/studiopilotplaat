import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createThemeStore, parseTheme, contrast } from './themes.mjs';

const xml = `<Ableton><Theme>
<Desktop Value="#eeeeee" /><DetailViewBackground Value="#dddddd" />
<ControlForeground Value="#111111" /><ControlBackground Value="#cccccc" />
<ChosenDefault Value="#ffb901" /><ChosenRecord Value="#ff0000" />
</Theme></Ableton>`;

test('parses Ableton palette values and keeps text readable', () => {
  const theme = parseTheme(xml, 'Light', 'test');
  assert.equal(theme.scheme, 'light');
  assert.equal(theme.vars['--background'], '#eeeeee');
  assert.equal(theme.vars['--accent-fill'], '#ffb901');
  assert.ok(contrast(theme.vars['--text'], theme.vars['--background']) >= 4.5);
  assert.ok(contrast(theme.vars['--surface-text'], theme.vars['--surface']) >= 4.5);
  assert.ok(contrast(theme.vars['--control-text'], theme.vars['--control']) >= 4.5);
  assert.ok(contrast(theme.vars['--on-accent'], theme.vars['--accent-fill']) >= 4.5);
});
test('supports older RGB theme colors and rejects invalid themes', () => {
  const rgb = xml.replace('<Desktop Value="#eeeeee" />', '<Desktop><R Value="20" /><G Value="30" /><B Value="40" /><Alpha Value="255" /></Desktop>');
  assert.equal(parseTheme(rgb, 'RGB', 'rgb').vars['--background'], '#141e28');
  assert.throws(() => parseTheme('<Theme></Theme>', 'Invalid', 'bad'), /Missing theme color/);
  assert.throws(() => parseTheme('<!DOCTYPE x><Theme></Theme>', 'Invalid', 'bad'), /declarations/);
});
test('supports partial custom palettes without dropping installed themes', () => {
  const partial = '<Theme><Desktop Value="#000000" /><SurfaceBackground Value="#111111" /><RetroDisplayForeground Value="#ffffff" /></Theme>';
  const theme = parseTheme(partial, 'Partial', 'partial');
  assert.equal(theme.adapted, true);
  assert.equal(theme.vars['--control'], '#111111');
  assert.equal(theme.vars['--text'], '#ffffff');
});
test('loads every installed theme, excludes resource forks, and persists selection atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'livepilot-themes-'));
  try {
    const source = path.join(root, 'Themes'), settings = path.join(root, 'Settings');
    await mkdir(source);
    await writeFile(path.join(source, 'Light.ask'), xml);
    await writeFile(path.join(source, 'Dark.ask'), xml.replace('#eeeeee', '#111111'));
    await writeFile(path.join(source, '._Light.ask'), 'resource fork');
    await writeFile(path.join(source, 'Broken.ask'), '<Theme></Theme>');
    const store = createThemeStore(settings);
    await store.configure([source]);
    const catalog = await store.catalog();
    assert.equal(catalog.themes.length, 4);
    assert.equal(catalog.warnings.length, 1);
    assert.match(catalog.warnings[0], /Broken.ask/);
    const selected = catalog.themes.find(t => t.name === 'Light').id;
    await store.select(selected);
    assert.equal((await createThemeStore(settings).catalog()).selected, selected);
    const raw = JSON.parse(await readFile(path.join(settings, 'appearance.json'), 'utf8'));
    assert.equal(raw.format, 'livepilot-studio-appearance');
    assert.equal(raw.version, 1);
    await assert.rejects(store.select('missing'), /not installed/);
    await writeFile(path.join(settings, 'appearance.json'), '{"format":"other"}');
    await assert.rejects(store.configure([source]), /corrupt/);
    assert.equal(await readFile(path.join(settings, 'appearance.json'), 'utf8'), '{"format":"other"}');
  } finally { await rm(root, { recursive: true }); }
});
