#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/studio/livepilot-control"
copilot_home="${COPILOT_HOME:-$HOME/.copilot}"
target_dir="$copilot_home/extensions/livepilot-control"

if [[ ! -f "$source_dir/extension.mjs" || ! -f "$source_dir/creative.html" ]]; then
  printf 'Creative Studio source is missing under %s\n' "$source_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"
rsync -a --exclude='.DS_Store' "$source_dir/" "$target_dir/"
node --check "$target_dir/extension.mjs"
node --check "$target_dir/standalone.mjs"
printf 'Synced Creative Studio to %s\nRestart Copilot to reload the canvas extension.\n' "$target_dir"