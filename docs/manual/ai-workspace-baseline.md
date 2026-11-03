# AI Workspace and MCP Baseline

This guide separates provider setup, shared repository configuration, and
runtime services. A config file being present does not mean its server is
running or connected. Claude Code is the primary client for this workspace;
Copilot and Codex are separate clients with their own registrations.

## Active Components

| Component | Role | Shared source | What it needs |
|---|---|---|---|
| Claude Code | Primary AI client used for this workspace | `CLAUDE.md`; project MCP registration in `~/.claude.json` | Claude Code and a local checkout with `.venv` |
| LivePilot MCP | Gives an AI client LivePilot tools | Claude's local `LivePilot-dev` entry; `.vscode/mcp.json` for VS Code | Local checkout, `.venv`, and installed Python requirements |
| VS Code | Editor and optional Copilot host | `.vscode/settings.json` | A local checkout for terminal and process access |
| GitHub Copilot | Separate optional VS Code client | `AGENTS.md`, `.github/copilot-instructions.md` | Copilot enabled in VS Code |
| Codex | Separate optional client/plugin | `AGENTS.md`, `livepilot/.Codex-plugin/plugin.json` | Codex installed and its local MCP path points to an existing checkout |
| Ableton Remote Script | Executes Live Object Model commands | `remote_script/LivePilot/` | Installed in Ableton's User Library; TCP port 9878 |
| M4L Analyzer bridge | Provides analyzer/LiveAPI data | `m4l_device/` | Analyzer loaded in Live; UDP 9880 and OSC 9881 |

VS Code is the editor, not an AI model. Claude Code, Copilot, and Codex are
separate clients. Claude Code can run the LivePilot MCP server without the
optional Claude marketplace plugin. Plugin manifests provide client-specific
instructions and packaging; they do not install or activate the client by
themselves. MCP connects a client to the LivePilot server. The Ableton Remote
Script and M4L bridge are separate runtime connections behind that server.

## Studio Runtime Requirements

Routine studio controls must execute through application logic and the
Ableton integration without requiring a Claude conversation or model call
for each action. AI assistance must be optional and explicitly invoked;
normal controls must remain usable with Claude stopped. Development-time
AI clients are separate from studio runtime dependencies.

After the intended studio setup is working, tested, and confirmed by the
user, disable unused AI clients, agents, plugins, and MCP registrations in
the local project configuration. Retain only integrations needed by the
confirmed workflow, including the Ableton Remote Script and any required
analyzer or MCP service. Disable rather than delete so changes are
reversible; do not remove shared compatibility manifests or alter unrelated
global integrations. Keep logging enabled.

Acceptance requires testing routine studio controls with Claude stopped,
verifying that those actions make no model requests, and repeating the
runtime checks after unused integrations are disabled. These requirements
are pending implementation and confirmation, not a claim of current
runtime independence or completed cleanup.

## Configuration Files

| File or directory | Purpose | Shared in Git? |
|---|---|---|
| `.vscode/mcp.json` | VS Code launches LivePilot with `${workspaceFolder}/.venv/bin/python -m mcp_server` | Yes; explicitly allowed by `.gitignore` |
| `.vscode/settings.json` | Workspace editor/test settings and MCP sampling permissions | Yes; explicitly allowed by `.gitignore` |
| `~/.claude.json` | Claude Code project-scoped MCP registration (`LivePilot-dev`) | No; local user configuration |
| `~/.codex/config.toml` | Codex MCP registrations | No; local user configuration |
| `AGENTS.md` | Project-wide agent rules; primary shared baseline for coding agents | Yes |
| `CLAUDE.md` | Claude-specific project instructions and workflows | Yes |
| `.github/copilot-instructions.md` | Copilot entry point; points to the shared baseline | Yes |
| `livepilot/.claude-plugin/` and `.claude-plugin/` | Claude plugin and marketplace metadata | Yes |
| `livepilot/.Codex-plugin/` | Codex plugin metadata | Yes |
| Root `.mcp.json`, `.claude/`, `.codex/`, `.venv/`, `.env*` | Per-machine configuration, state, or secrets | No; local only or ignored |

Keep the client-specific files separate: Claude, Codex, and VS Code use
different config formats. Their local entries should point to the same
checkout rather than copying secrets or machine-specific paths into the repo.
The optional root `.mcp.json` is ignored; the committed VS Code entry point is
`.vscode/mcp.json`. Claude Code's project-scoped entry is stored in
`~/.claude.json`, not in the Claude plugin manifest.

## Verified Machine State

Checked 2026-11-03:

- Claude Code has a project-scoped `LivePilot-dev` entry. Its Python import
  succeeds when launched from the LivePilot checkout root. Claude is the
  primary client; the LivePilot plugin does not need to be marketplace
  installed for this MCP connection.
- The duplicate project-scoped `LivePilot` entry was removed; Claude now
  reports only the connected `LivePilot-dev` server.
- The Codex config contains a `LivePilot` entry whose configured checkout path
  does not exist on this machine. Treat it as stale, not active.
- The committed VS Code MCP entry was added in the workspace/reference merge
  after v5.3. It is separate from Claude's working project-scoped entry and
  requires opening a local checkout; a GitHub virtual-filesystem workspace
  cannot launch its `.venv` process.
- No LivePilot Remote Script TCP listener or M4L UDP listener was found during
  the last port check. This says nothing about whether Claude itself is open;
  it means Ableton/bridge runtime health still needs a separate check.

## Local Development Setup

The committed `.vscode/mcp.json` is intended for a **local filesystem
checkout**. It cannot launch Python when the repository is opened only through
a GitHub virtual-filesystem view. In that case, open or clone the repository
as a local folder first, then from the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Then use VS Code's **MCP: List Servers** command to start or restart
`LivePilot`. The MCP server command is `python -m mcp_server`. Restarting the
MCP server does not start Ableton or install its Remote Script; start Ableton
and verify the Remote Script connection separately. See
[`dev-install.md`](dev-install.md) for the full local-development procedure.

## Where Changes Go

- Commit shared source, instructions, and workspace configuration to the
  current repository branch. The local checkout's verified `origin` is
  `https://github.com/Plaat2000/studiopilotplaat.git`; `package.json` still
  names `dreamrec/LivePilot` as its repository URL. Treat `git remote -v` as
  the push destination and verify it before pushing or publishing.
- For a local LivePilot development install, run
  `node bin/livepilot.js --install` from that checkout to copy the Remote
  Script to Ableton's configured User Library. Do not use `npx` for local
  edits; it installs the published package instead.
- After changing `remote_script/LivePilot/*.py`, install the local script and
  call `reload_handlers` through MCP. After changing analyzer Max source,
  rebuild in Max and run `bash scripts/sync_amxd_targets.sh --apply` to update
  the configured install targets.
- For releases, follow the version and metadata workflow in `AGENTS.md`,
  `CLAUDE.md`, and `scripts/sync_metadata.py`. Major functional changes get a
  version bump and repository commit; sync the local workspace from the
  committed branch. Do not push or publish unless that release action is
  explicitly part of the task.

## Sources Of Truth

- `AGENTS.md` — project architecture and binding agent rules.
- `CLAUDE.md` — Claude workflow and release details.
- `.vscode/mcp.json` — VS Code's actual LivePilot launch entry.
- `docs/manual/dev-install.md` — local checkout, Python environment, and
  Ableton installation steps.
- `scripts/sync_metadata.py` — enforced version and metadata consistency.