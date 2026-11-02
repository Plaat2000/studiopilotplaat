#!/usr/bin/env bash
# find_bundled_max.sh — locate Ableton's bundled Max and any standalone Max installs.
#
# Use when Live's Settings → File/Folder → "Max Application" won't let you
# select "Use bundled Version" (greyed out) and Max for Live devices won't load.
# That state means Live cannot find a usable Max inside its own app bundle.
#
# The script:
#   1. Finds every Ableton Live .app on this machine
#   2. Reports its edition + version and whether the bundled Max exists inside it
#      (Contents/App-Resources/Max/Max.app)
#   3. Finds standalone Max installs (Max 8 / Max 9 / Cycling '74 folders, mdfind)
#   4. Tells you exactly which path to set as the Max Application in Live
#
# macOS only. Read-only — changes nothing.

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

plist_version() {
  # $1 = path to .app — prints CFBundleShortVersionString or "?"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$1/Contents/Info.plist" 2>/dev/null || echo "?"
}

# ---------------------------------------------------------------------------
bold "== Ableton Live installations =="

live_apps=()
while IFS= read -r app; do
  live_apps+=("$app")
done < <(
  { ls -d /Applications/Ableton\ Live*.app "$HOME"/Applications/Ableton\ Live*.app 2>/dev/null || true
    mdfind "kMDItemCFBundleIdentifier == 'com.ableton.live'" 2>/dev/null || true
    # Non-standard installs: scan every mounted volume two levels deep
    # (catches e.g. /Volumes/DATA/APPS/Ableton Live 12 Suite.app).
    # Spotlight often doesn't index external volumes, so mdfind misses these.
    find /Volumes/*/ -mindepth 1 -maxdepth 2 -name "Ableton Live*.app" -type d \
      -not -path "*/.Trashes/*" 2>/dev/null || true
  } | sort -u
)

if [[ ${#live_apps[@]} -eq 0 ]]; then
  bad "No Ableton Live installation found in /Applications, ~/Applications, or any mounted volume."
  exit 1
fi

bundled_max_found=""
for app in "${live_apps[@]}"; do
  [[ -d "$app" ]] || continue
  edition="(unknown edition)"
  case "$app" in
    *Suite*)    edition="Suite — includes Max for Live" ;;
    *Standard*) edition="Standard — Max for Live NOT included (requires separate M4L license or Suite)" ;;
    *Intro*)    edition="Intro — Max for Live NOT included" ;;
    *Lite*)     edition="Lite — Max for Live NOT included" ;;
  esac
  echo
  ok "$app"
  info "Version: $(plist_version "$app")  |  $edition"

  # Warn when Live sits on a non-APFS/HFS volume — exFAT/FAT can break
  # app-bundle semantics (symlinks, ownership) and Gatekeeper behavior.
  mnt=$(df -P "$app" 2>/dev/null | awk 'NR==2 {for(i=6;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":"")}')
  vol_fs=$(mount | grep -F "on $mnt " | sed -E 's/.*\(([a-z0-9]+),.*/\1/' | head -1)
  if [[ -n "$vol_fs" && "$vol_fs" != "apfs" && "$vol_fs" != "hfs" ]]; then
    bad "Volume '$mnt' is $vol_fs (not APFS/HFS). Apps on exFAT/FAT volumes can"
    info "fail code-signature checks or lose framework symlinks — a common cause of"
    info "M4L devices not loading. Prefer moving Live to an APFS volume."
  fi

  bundled="$app/Contents/App-Resources/Max/Max.app"
  if [[ -d "$bundled" ]]; then
    ok "Bundled Max present: $bundled (Max $(plist_version "$bundled"))"
    bundled_max_found="$bundled"
    # A quarantine flag on the bundled Max can make Live refuse to use it.
    if xattr -p com.apple.quarantine "$bundled" >/dev/null 2>&1; then
      bad "Bundled Max is quarantined — Live may refuse it. Fix with:"
      info "sudo xattr -dr com.apple.quarantine \"$bundled\""
    fi
    # Broken signature => macOS blocks launch => Live greys out the option.
    if codesign -v "$bundled" 2>/dev/null; then
      ok "Bundled Max code signature valid"
    else
      bad "Bundled Max code signature INVALID — macOS will refuse to launch it."
      info "Reinstall Live with the full installer from ableton.com/account."
    fi
    # exFAT/FAT volumes historically drop framework symlinks; verify one.
    if [[ ! -L "$bundled/Contents/Frameworks/MaxAudioAPI.framework/MaxAudioAPI" ]]; then
      bad "Framework symlinks inside bundled Max are missing/materialized —"
      info "the bundle was copied through a filesystem that dropped symlinks."
      info "Reinstall Live (full installer) directly onto this volume."
    fi
  else
    bad "Bundled Max MISSING at: $bundled"
    if [[ "$app" == *Suite* ]]; then
      info "A Suite install should contain this. The install is incomplete/corrupted —"
      info "re-download the FULL installer from ableton.com/account (not the slim/web installer)"
      info "and reinstall. This is why 'Use bundled Version' is greyed out."
    else
      info "This edition does not ship Max. You need Live Suite, an M4L add-on license,"
      info "or a standalone Max install selected as the Max Application (see below)."
    fi
  fi
done

# ---------------------------------------------------------------------------
echo
bold "== Standalone Max installations =="

standalone=()
while IFS= read -r app; do
  standalone+=("$app")
done < <(
  { ls -d /Applications/Max.app \
          /Applications/Max\ [0-9]*/Max.app \
          /Applications/Cycling\ \'74/*/Max.app \
          "$HOME"/Applications/Max.app \
          "$HOME"/Applications/Max\ [0-9]*/Max.app 2>/dev/null || true
    mdfind "kMDItemCFBundleIdentifier == 'com.cycling74.Max'" 2>/dev/null || true
    find /Volumes/*/ -mindepth 1 -maxdepth 3 -name "Max.app" -type d \
      -not -path "*/App-Resources/*" -not -path "*/.Trashes/*" 2>/dev/null || true
  } | grep -v '/App-Resources/' | sort -u || true
)

if [[ ${#standalone[@]} -eq 0 ]]; then
  bad "No standalone Max found."
  info "Download from https://cycling74.com/downloads — Max runs M4L in trial/unlicensed mode."
else
  for app in "${standalone[@]}"; do
    [[ -d "$app" ]] || continue
    ok "$app (Max $(plist_version "$app"))"
  done
fi

# ---------------------------------------------------------------------------
echo
bold "== What to do in Live =="
if [[ -n "$bundled_max_found" ]]; then
  cat <<EOF
  Bundled Max exists. In Live: Settings → File/Folder → Max Application →
  choose "Use bundled Version". If it is STILL greyed out with the bundle
  present, reset the preference: quit Live, then delete
  ~/Library/Preferences/Ableton/Live <version>/Preferences.cfg
  (Live rebuilds it on next launch) and re-select the bundled version.
EOF
elif [[ ${#standalone[@]} -gt 0 ]]; then
  cat <<EOF
  No bundled Max, but a standalone Max was found. In Live:
  Settings → File/Folder → Max Application → Browse → select:
    ${standalone[0]}
  Then restart Live and reload the M4L device.
EOF
else
  cat <<EOF
  No Max found anywhere. Either:
    1. Reinstall Live Suite with the FULL installer from ableton.com/account
       (restores the bundled Max), or
    2. Install standalone Max from https://cycling74.com/downloads and select
       it under Settings → File/Folder → Max Application.
EOF
fi
