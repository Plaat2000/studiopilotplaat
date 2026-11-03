import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const bundleId = 'com.ableton.live';
const statusScript = `
ObjC.import('AppKit');
var workspace = $.NSWorkspace.sharedWorkspace;
var apps = workspace.runningApplications;
var running = false;
for (var i = 0; i < apps.count; i++) {
  if (ObjC.unwrap(apps.objectAtIndex(i).bundleIdentifier) === '${bundleId}') running = true;
}
var url = workspace.URLForApplicationWithBundleIdentifier('${bundleId}');
JSON.stringify({running: running, installed: !url.isNil()});
`;
const options = { timeout: 10000, maxBuffer: 65536, encoding: 'utf8' };

export function createAbletonApp({ platform = process.platform, execute = executeFile } = {}) {
  async function status() {
    if (platform !== 'darwin') return { supported: false, running: null, installed: null,
      message: 'Automatic Ableton detection and launch are supported on macOS only.' };
    let result;
    try {
      const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', statusScript], options);
      result = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Could not check whether Ableton is running: ${error.message}`, { cause: error });
    }
    if (typeof result?.running !== 'boolean' || typeof result?.installed !== 'boolean') {
      throw new Error('Ableton application check returned an invalid status.');
    }
    return { supported: true, running: result.running, installed: result.installed };
  }
  async function launch(input) {
    if (input?.confirmed !== true) throw new Error('Click the Studio title to confirm starting Ableton.');
    const current = await status();
    if (!current.supported) throw new Error(current.message);
    if (current.running) return { ...current, launch_requested: false };
    if (!current.installed) throw new Error('Ableton Live is not registered as an installed application on this Mac.');
    try {
      await execute('/usr/bin/open', ['-b', bundleId], options);
    } catch (error) {
      throw new Error(`Could not start Ableton Live: ${error.message}`, { cause: error });
    }
    return { ...current, launch_requested: true };
  }
  return { status, launch };
}
