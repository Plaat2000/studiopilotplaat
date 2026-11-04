# studiopilotplaat 3.0 — Workspace and Runtime Overview

## Release Status

**studiopilotplaat 3.0** is a project snapshot on `studiopilotplaat-3.0`,
not a LivePilot engine 3.0.0 release. The working engine and frozen analyzer
remain at **1.31.0**. Further analyzer work is deferred to project version 3.1.
The branch/tag will be published and cloned into a sibling local workspace.
Older branches and tags remain unchanged.

The verified baseline on **2026-11-04** is LivePilot **1.31.0**, local commit
`9f2a5db`, on branch `countrycreativestudiov.2`. The remote branch points to
`793100a`: four local commits have not yet been pushed. The existing public
`v5.3` tag is a separate historical snapshot, not the current package version.
Preserve that tag and older versions when preparing 3.0.

## Where Everything Lives

| Layer | Location | What it contains |
|---|---|---|
| Local checkout / VS Code workspace | `/Volumes/DATA/Coding/studiopilotplaat` | Editable source, documentation, tracked workspace settings, and the local Git repository |
| Local Git storage | `.git/` inside the checkout | Commits, local branches, tags, and remote-tracking references; a commit stays local until pushed |
| Public remote | <https://github.com/Plaat2000/studiopilotplaat> | Pushed Git commits, branches, and tags; not the running workspace |
| Studio source | [`../../studio/livepilot-control/`](../../studio/livepilot-control/) | WebUI, canvas extension, and standalone launcher |
| Installed Copilot Studio copy | `~/.copilot/extensions/livepilot-control/` | Separate local runtime copy; Git push does not update it |
| Python environment | `.venv/` inside the checkout | Local interpreter and dependencies; excluded from Git |
| Ableton Remote Script | Ableton's configured User Library / Remote Scripts / LivePilot | Installed copy executed inside Live; separate from editable repository source |
| M4L analyzer | Ableton's configured User Library / Presets / Audio Effects / Max Audio Effect | Frozen device loaded in Live; separate from editable JS/Max source |
| Local user data | `~/.livepilot/` | Private atlas scans, overlays, memory, preferences, and runtime state; not published by a repository push |
| Chrome app shortcut | Local Applications / Chrome Apps | Opens a local WebUI URL; it is not the repository or a deployed GitHub application |

`~` denotes the current user's home directory. Installation paths can differ
between machines. The configured `origin` remote, not the repository URL in
`package.json`, determines where `git push origin` sends changes.

## Commit and Push: What Moves?

```text
LOCAL MACHINE
  VS Code workspace: /Volumes/DATA/Coding/studiopilotplaat
      |
      | edit tracked files, stage, commit
      v
  Local .git history and current branch
      |
      | explicit push of branch and, separately, release tag
      v
GITHUB
  Plaat2000/studiopilotplaat
  Published source snapshots — no local Python, Ableton, or WebUI process

LOCAL RUNTIME COPIES (separate install/sync steps)
  Repository Studio source -> ~/.copilot/extensions/livepilot-control/
  Repository Remote Script -> Ableton User Library / Remote Scripts
  Frozen analyzer          -> configured Max / Ableton install targets
```

Pushing does **not** move the workspace to GitHub, start services, install
dependencies, refresh installed runtime copies, or publish the localhost WebUI.
Opening a GitHub virtual-filesystem view is not equivalent to opening the
local checkout: it cannot launch this machine's Python `.venv`.

Shared [VS Code settings](../../.vscode/settings.json) and
[MCP configuration](../../.vscode/mcp.json) are tracked. Per-machine credentials,
`.env` files, `.venv`, local AI-client registrations, user library inventories,
and private memory stay local.

## Active Clients, Agents, and AI Engines

These are point-in-time observations, not promises that every configured
integration is connected.

| Component | Verified status | Role and limits |
|---|---|---|
| VS Code | Running with the local checkout | Editor and host; VS Code itself is not an AI model |
| GitHub Copilot / Copilot SDK | Active for this conversation; runtime process observed | Current assistant and Studio canvas host. It is an AI assistant using Copilot SDK in VS Code, not a Claude conversation |
| Underlying chat model | Not independently queried in this runtime check | The selected model can change per session. Do not infer it from `CLAUDE.md`, an open app, or a configured MCP server |
| Claude Desktop | App process observed | An open app does not prove a model request or MCP connection is active |
| Claude Code | Project `LivePilot-dev` MCP registration verified | Separate client configuration pointing to this checkout's `.venv`; connection was not verified for Claude in this check |
| Codex | Runtime process observed under VS Code | Separate AI client; no Codex-specific LivePilot connection verified here |
| Background agents | None running in this conversation at the documentation check | Available specialized agent types are capabilities, not active workers |
| LivePilot creative engines | Repository application logic | Composer, analysis, memory, and planning modules are not themselves proof of an external Claude/Copilot model request |

The workspace's `copilot/auto` and `copilotcli/auto` sampling permissions
authorize possible sampling; they do not prove which model is running or that
an action made a model request. Ordinary controls and explicitly requested AI
assistance must be distinguished. Independence from an AI client still needs
the acceptance checks described in the
[AI Workspace and MCP Baseline](ai-workspace-baseline.md#studio-runtime-requirements).

## Live MCP and Ableton Runtime

| Service | Verified state on 2026-11-04 | Address / launch source |
|---|---|---|
| Creative Studio WebUI | Listening; browser page loaded | <http://127.0.0.1:7666/>; Copilot canvas host |
| LivePilot MCP | Live tool call succeeded; process working directory is this checkout | Stdio, `${workspaceFolder}/.venv/bin/python -m mcp_server` |
| Ableton Remote Script | Listening with an established MCP connection | Local TCP `9878` |
| M4L analyzer bridge | UDP listener present; capability probe reports measured analyzer data | Local UDP `9880`; commands target OSC `9881` |
| Memory | Capability probe reports available | Local LivePilot persistence |
| FluCoMa | Capability probe reports available | Optional analysis integration |
| LivePilot web research | Capability probe reports unavailable | Separate from browser viewing or another AI client's internet tools |

The MCP process and Studio host were observed under the Copilot runtime.
Only one TCP client can hold the Ableton Remote Script connection at a time.
Do not start competing MCP instances or use raw TCP calls to test it.
The analyzer must remain last on the master effects chain.

## Engine Release Procedure for Future Versions

1. Review this overview and the intended release scope before changing metadata.
2. Prepare the requested engine version consistently using
   [`sync_metadata.py`](../../scripts/sync_metadata.py) and the release rules
   in [`AGENTS.md`](../../AGENTS.md). Do not merely rename a commit or change
   `package.json` alone.
3. Bump `var VERSION` in the bridge JS before re-freezing the analyzer in Max.
   Verify the embedded version, commands, identifiers, and install copies with
   `bash scripts/sync_amxd_targets.sh`; a real JS change requires a genuine freeze.
4. Run targeted tests and release consistency checks. Sync Studio with
   `bash scripts/sync_creative_studio.sh`; reload the extension after syncing.
5. Commit reviewed shared files locally. Verify `git status`, branch, remote,
   and ahead/behind state. Preserve old tags and branches.
6. Only after publication approval, push the intended branch and new tag.
   Use VS Code's authenticated integrated terminal/task when the assistant's
   shell cannot access GitHub credentials; never embed credentials in config.
7. If publishing a GitHub release, follow the full release runbook, including
   the required MCPB bundle. A branch/tag push alone is not a complete release.

The [workspace version workflow](workspace-version-workflow.md) records the
default branch/publish/clone procedure and the sanitized technical handoff.
Full chats remain in local client storage; Git clone does not transfer them.

## Related Documentation

- [AI workspace and MCP baseline](ai-workspace-baseline.md)
- [Local development installation](dev-install.md)
- [Studio launcher and standalone mode](../../studio/livepilot-control/README.md)
- [Max freeze workflow](../MAX_FREEZE_WORKFLOW.md)
