# Workspace Version Workflow

This repository's preference: a requested new version gets a **new branch,
new tag, GitHub publication, and a new local checkout of the published branch**.
Do not rewrite older branches, commits, or tags.

## Procedure

1. Check dirty files, the current branch, remote destination, and the requested
   version scope. Include only approved changes and preserve existing history.
2. Create a unique version branch. Update engine metadata when an engine release
   is requested; a branch name is not a substitute for a package version bump.
3. Run focused tests and `python3 scripts/sync_metadata.py --check`. For engine
   releases, bump bridge JS before a genuine Max freeze, then verify with
   `bash scripts/sync_amxd_targets.sh` and sync approved install targets.
   Never publish a failed or stale freeze.
4. Commit reviewed source, documentation, and a sanitized technical handoff.
   Full chats, credentials, machine-private inventories, and private runtime
   state stay local. Git history is preserved by the new branch's ancestry.
5. Once all gates pass, push the new branch and tag to the verified `origin`.
   Use an authenticated VS Code terminal/task if the assistant shell has no
   credentials. Do not force-push or move an existing tag.
6. Clone that branch into the requested new local folder, preserving all Git
   history. Use `git pull --ff-only` there and verify local HEAD equals the
   published branch. Never overwrite an existing folder.
7. Open the new checkout as the workspace. When supported, use the chat host's
   workspace-change operation to preserve this chat's identity and history.
   Keep the old checkout intact.
   Recreate its Python environment using documented dependency commands only
   when needed. Update approved local MCP paths; do not copy `.venv` or secrets.
   Stop the old workspace's own MCP instance before starting its replacement
   because Ableton permits only one TCP client.
8. Verify the new UI/MCP runtime and report any integration that is merely
   configured rather than connected. Follow the full release runbook, including
   MCPB packaging, if a GitHub release is also requested.

## Chat Continuity

Cloning and pulling transfer Git history, **not** VS Code/Copilot chat history.
Existing chats remain in the AI client's local session storage. The current
chat can retain its identity/history through the host's workspace-change tool;
other chats remain in their original workspaces. Preserve storage; do not manually relocate
internal session databases or claim automatic import into a new workspace.

Carry a sanitized handoff in repository documentation. Retain clickable session
links privately for reopening earlier chats. If the client cannot attach an
old chat to the new folder, open it separately and continue in a new chat using
the handoff. Never export full transcripts into the public repository.

## Current 3.0 Handoff

- Branch prepared: `studiopilotplaat-3.0`; requested tag: `studiopilotplaat-3.0`.
- Project snapshot: 3.0; retained engine and analyzer version: `1.31.0`.
- Requested next checkout: a sibling folder named `studiopilotplaat-3.0`.
- WebUI source: `studio/livepilot-control/`; localhost port: `7666`.
- MCP: workspace Python stdio server; Ableton TCP `9878`; analyzer UDP `9880`.
- Further analyzer work is deferred to project version 3.1.
- Validate, commit, push branch/tag, clone, pull, open, and verify.

See the [3.0 overview](studiopilotplaat-3.0-overview.md) for the dated baseline.
