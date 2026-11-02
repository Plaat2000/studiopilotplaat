"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function configuredUserLibrary(preferencesDir, version) {
  const config = path.join(preferencesDir, "Library.cfg");
  if (!fs.existsSync(config)) return null;
  try {
    const xml = fs.readFileSync(config, "utf8");
    const library = xml.match(/<UserLibrary\b[^>]*>([\s\S]*?)<\/UserLibrary>/);
    if (!library) throw new Error("UserLibrary is missing from Library.cfg");
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    const attribute = (tag) => {
      const match = library[1].match(new RegExp(`<${tag}\\b[^>]*\\bValue=(["'])(.*?)\\1`));
      if (!match) throw new Error(`${tag} is missing from Library.cfg`);
      return match[2].replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) =>
        entity[0] === "#" ? String.fromCodePoint(
          entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
        ) : entities[entity]
      );
    };
    const parent = attribute("ProjectPath");
    const name = attribute("ProjectName");
    if (!path.isAbsolute(parent) || !name || path.basename(name) !== name || name === "." || name === "..") {
      throw new Error("Configured library must have an absolute parent and a single folder name");
    }
    return {
      path: path.join(parent, name, "Remote Scripts"),
      description: `Configured Ableton User Library (${version})`,
    };
  } catch (error) {
    console.warn(`Cannot read configured Ableton User Library from ${config}: ${error.message}`);
    return null;
  }
}

/**
 * Return an array of {path, description} for candidate Ableton Remote Scripts
 * directories on the current platform.
 */
function findAbletonPaths() {
  const candidates = [];
  const home = os.homedir();
  const platform = os.platform();

  if (platform === "darwin") {
    // macOS candidate 1: User Library default
    candidates.push({
      path: path.join(home, "Music", "Ableton", "User Library", "Remote Scripts"),
      description: "Ableton User Library (default)",
    });

    // macOS candidate 2: Preferences — scan for Live 12.* dirs
    const prefsDir = path.join(home, "Library", "Preferences", "Ableton");
    if (fs.existsSync(prefsDir)) {
      try {
        const entries = fs.readdirSync(prefsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const configured = [];
        for (const entry of entries) {
          if (/^Live \d+/.test(entry)) {
            const library = configuredUserLibrary(path.join(prefsDir, entry), entry);
            if (library) configured.push(library);
            candidates.push({
              path: path.join(prefsDir, entry, "User Remote Scripts"),
              description: `Ableton Preferences (${entry})`,
            });
          }
        }
        candidates.unshift(...configured);
      } catch {
        // permission error — skip
      }
    }
  } else if (platform === "win32") {
    const userProfile = process.env.USERPROFILE || home;
    const appData = process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");

    // Windows candidate 1: Documents User Library
    candidates.push({
      path: path.join(userProfile, "Documents", "Ableton", "User Library", "Remote Scripts"),
      description: "Ableton User Library (default)",
    });

    // Windows candidate 2: AppData — scan for Live 12.* dirs
    const abletonAppData = path.join(appData, "Ableton");
    if (fs.existsSync(abletonAppData)) {
      try {
        const entries = fs.readdirSync(abletonAppData).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const configured = [];
        for (const entry of entries) {
          if (/^Live \d+/.test(entry)) {
            const library = configuredUserLibrary(path.join(abletonAppData, entry, "Preferences"), entry);
            if (library) configured.push(library);
            candidates.push({
              path: path.join(abletonAppData, entry, "Preferences", "User Remote Scripts"),
              description: `Ableton AppData (${entry})`,
            });
          }
        }
        candidates.unshift(...configured);
      } catch {
        // permission error — skip
      }
    }
  }

  // Filter: keep candidate if the path itself exists, or its parent exists
  return candidates.filter((c) => {
    try {
      return fs.existsSync(c.path) || fs.existsSync(path.dirname(c.path));
    } catch {
      return false;
    }
  });
}

module.exports = { findAbletonPaths };
