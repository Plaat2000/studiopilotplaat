# Countryside Creative Studio v2 — grouped interfaces

Personal Copilot canvas, available across workspaces. Open the `livepilot-control`
canvas to control the session's configured LivePilot MCP server. Ableton and its
LivePilot Remote Script must already be running.

If Copilot reports that the MCP tool catalog changed before invocation, Studio
resolves current metadata and retries once. Other execution failures are not
retried automatically, so potentially applied writes cannot be repeated.

The web interface always uses **http://127.0.0.1:7666/**, both as a Copilot
canvas and in standalone mode. Track windows and detailed controls use the same
port. Only one Studio server can own this port at a time; a conflicting canvas,
standalone process or other application produces an explicit startup error,
never a fallback to a random port. Test fixtures can inject a separate listener
port without affecting the production entry points.

Port 7666 avoids privileged-port requirements and Chromium's restricted port
6666. Studio does not change browser security settings or choose another port
automatically.

On page load, Studio checks macOS application status independently of MCP.
If Ableton Live is installed but stopped, the **Countryside Creative Studio**
heading becomes a keyboard-accessible launch button. Clicking it starts only
the registered `com.ableton.live` application through Launch Services, checks
startup for up to 30 attempts, then tries to read the session. It does not open
a second instance, start playback or change device settings. If Live is still
initializing, **Refresh all tracks** rechecks the application and connection.
Running Ableton with an unavailable MCP connection is shown as a connection
error, never mistaken for a stopped application. Detection/launch failures and
missing installations are explicit. App endpoints use the same local token and
origin protection as other controls and work even when MCP is unavailable.
Automatic app detection/launch currently supports macOS only; no Apple Events
UI automation permissions or shell commands are needed.

The main dashboard focuses on Perception and Memory. Every regular track,
return, and master has a visual card with meters, device names, mute/solo state,
and an M4L analysis window. The previous architecture library and detailed
mixer/device controls remain available at `/classic`.

Each main section can be collapsed or expanded by clicking its heading or using
Enter/Space with the heading focused. Sections start expanded and keep their
individual state during dashboard refreshes. Collapsing only hides the section;
it does not clear form values or change anything in Ableton.

**Where to focus next** sits directly below Session Map (Composer still comes
first only for a verified blank Set). Choose **Selected tracks** or **Whole song**
before requesting ideas; a selected group means its bus, not automatic member
selection. Whole song covers tracks, buses, returns and master, but is never a
batch edit. The request reads actual top-level devices, exposed rack macros and
plugin parameters. It does not install devices or expose hidden plugin controls.
Ideas name the track, device and knob, show the current formatted Live value and
provide a slider and numeric raw-value target. Curated Markdown direction rules
suggest small 5% raw-range trials only where an exposed parameter name matches;
these are hypotheses, not calibrated Hz/ms targets or measured improvements.
Unknown directions or controls have no guessed target: use the exposed-knob
picker for manual exploration. No modulation routing is created automatically.

**Adopt idea** and moving controls only edit a local draft. **Apply this knob**
requires confirmation, fresh identity/range/value checks and verified readback.
Its outcome and Bypass/Re-enable/Revert controls appear in the same section and
the outcome dialog. Existing Composer/track plans are preserved. Failed writes
remain uncertain and cannot be retried blindly. Session changes invalidate old
proposals; refresh suggestions after manual edits in Ableton. Drafts and saved
changes are in memory, not persisted across server restarts.

Track M4L windows place **Existing-track instrument plan** inside **Creative
direction**, not Track analysis. Opening a track window automatically reads and
shows its actual exposed control names, current values, and ranges from Ableton;
changing the device selector rereads that device. **All instruments and
plug-ins on this track** includes every top-level device except the analyzer.
These automatic reads generate no plugin settings or target values. The
optional native-synth alternatives are separate; relative timbre targets are
not plugin parameters. MIDI effects, racks, M4L, VST and AU devices use only
their exposed controls with the same draft, confirmation, readback and
Bypass/Re-enable/Revert workflow. If no controls are exposed, Studio explains
how to use Configure in Ableton. Transport and parameter-read failures still
surface as errors. Nested rack instruments are not recursively traversed.

## Standalone mode (no Copilot session, no per-action credits)

`standalone.mjs` runs the exact same Creative Studio without a Copilot session.
It spawns the LivePilot MCP server directly over stdio (plain JSON-RPC) and
wires it into the same control layer, so every button click is a free local
tool call — no Claude credits are consumed for any action.

```bash
cd /path/to/livepilot-repo   # directory containing .mcp.json
node ~/.copilot/extensions/livepilot-control/standalone.mjs
```

Options: `--config <path>` (MCP config, default `./.mcp.json` or
`$LIVEPILOT_MCP_CONFIG`), `--server <name>` (default `LivePilot`),
`--themes <dir,dir>` (Ableton theme directories), `--no-open` (print the URL
only). The browser opens automatically on macOS.

Constraints:

- The Ableton Remote Script accepts ONE TCP client on port 9878. Do not run
  standalone mode while a Copilot session also has the LivePilot MCP server
  connected — whichever connects second gets "Another client is already
  connected". Close the Copilot session (or its LivePilot server) first.
  The same applies to the M4L bridge UDP port 9880.
- The spawned server never receives sampling or elicitation support: any
  server-initiated request that would need a model is refused with a JSON-RPC
  error, so nothing can silently route through a paid model.
- Everything else is identical: same validation pipeline, same per-step
  approvals, same in-memory-only saved settings.

## Creative dashboard

- Session Map comes first, followed by Creative direction and Creative
  intelligence. Where to focus next is the last section; themes use a compact
  footer dropdown. For a blank set, Composer moves above Session Map. A scan
  verifies regular tracks have no devices, Session clips or Arrangement clips
  before promoting Composer; returns and master effects do not affect this check.
  Refresh all tracks after opening a different set or changing its content.
- v2 defaults to grouped track interfaces, including nested groups. Each
  collapsible group contains its bus card and member track cards with their
  existing meters, devices and analysis links. Group bus analysis remains
  separate from individual member analysis; track windows show the group path.
  Returns, master and ungrouped tracks stay at the root in Ableton order.
  Use Track view for a flat list, or Expand groups / Collapse groups.
  Collapse state survives refreshes in the open page and resets for a new Set;
  the initial view follows Ableton's fold state. These controls are local UI
  operations: they never regroup, solo, mute or fold tracks in Ableton.
- Group membership comes from `get_track_info.group_track_index`, not track
  names, audio routing or adjacency. Install the updated local Remote Script
  and call `reload_handlers` for older installations. Missing/invalid parent
  metadata is shown as a warning with the affected track kept separate.
  Incomplete membership is labelled explicitly, never shown as an empty group.
  If Live continues to return old handlers after install/reload, save the Set
  and restart Live, then refresh Studio. No automatic restart is performed.
  The Studio v2 label versions this personal interface, not the LivePilot
  package; no public package release or publishing is performed.
- Refresh scans all tracks; readings are timestamped, not continuously polled.
  Stopped meters are labelled peak-hold, never current audible activity.
- The Creative canvas header has Start (from the beginning), Stop, and a Loop
  toggle. The header stays fixed while the workspace sections and footer scroll
  underneath in their own pane. Short/narrow windows use a compact header so
  transport and loop controls remain reachable.
  Set the loop range in one-based bars with an exclusive end: 1 to 5
  covers bars 1–4. Conversion uses the current time signature (including 6/8).
  Set loop range preserves loop on/off; toggling off preserves the brace.
  These control the Arrangement loop, not individual clip loops, and do not
  release Session overrides. Readback verifies transport and loop requests.
- A track's M4L button opens a separate named window with read-only inspection,
  analyzer controls, Corpus Intelligence, Technique Memory, and Taste Graph.
  Its title and header identify the selected track and group path. Track windows
  show Creative direction first, Track analysis second, and Where to focus next
  third, with that track preselected for knob suggestions. Cached suggestions
  for other tracks are not shown unless their scope is explicitly selected.
  Refresh track context reloads evidence without changing the selected track.
  Each track has its own reusable window; the main dashboard order is unchanged.
  Track analysis hides empty spectrum space until measured bands are available.
  These intelligence functions also work session-wide from the main page.
- There is ONE shared analyzer, last on master. A track window can also load
  a separate analyzer as the last device on that track ("Load analyzer on this
  track", confirmed first) and read it with "Measure this track's analyzer":
  the track's own output after its devices, before group/master processing, with
  no solo or playback change. Its stream stays separate from master. This needs
  a stream-aware analyzer build; with an older frozen device nothing is loaded
  and the outcome explains that a re-freeze is required.
- Both per-track analysis methods are available: offline analysis of an occupied
  Session audio clip's original source (excludes warp, gain and effects), or
  explicitly approved temporary solo through master. Isolation requires playback
  already running, refuses recording, waits for cached mix data to expire, and
  restores and verifies prior solos even after measurement errors. Groups,
  returns, routing and master effects can still contribute; this is not a dry stem.
  Accumulated key history is explicitly mix-wide, not a per-track key detection.
- Master analyzer installation requires confirmation and is on the main screen.
  A misplaced master analyzer produces an error. Isolated master snapshots allow
  track analyzers only when their streams are separated.
- Mood, texture and taste preferences guide session-wide ranked advice.
  Mood has seven selectable directions and texture has eight, based on the
  emotional/physical mappings in `creative-thinking.md` and the modulation and
  layering techniques in `sound-design-deep.md`. Each choice shows a short
  plain-language insight. These are curated reference choices, not a live
  Markdown parser or verified acoustic outcomes.
  Both selectors start unselected; **Your own suggestion** starts empty and can
  be used alone or to refine either choice. The separate taste-preferences field
  is preserved. Custom suggestions are included in knowledge queries and
  Composer prompts, and stored with instrument-branch intent (branches still
  use their explicit relative parameter targets, not a text-to-synth conversion).
  Unsubmitted choices survive refreshes; previously saved free-text directions
  remain selectable. Choosing or typing makes no Ableton calls.
  Consultation shows the real knowledge plan, recalled techniques and global taste
  graph. Track advice distinguishes measured headroom evidence from role-based
  creative hypotheses and displays its basis.
- Composer generates new-layer steps. Virtual track/scene indices map only to
  newly appended tracks/scenes, never existing session content. Supported native
  instruments additionally offer existing-track synthesis branches. Relative target
  controls record intent, not verified acoustic target matches.
- Every executable plan step requires separate approval in order. Unsupported
  tools, missing bindings, stale session/device state and invalid parameter ranges
  are blocked. Parameter changes use fresh prereads and formatted readback.
  Ambiguous failures block retry; inspect Ableton and generate a fresh plan.
  There is no automatic audition, render verification, or undo of a whole plan.
  Review session-wide tempo changes before approval.
- Results open a confirmation dialog and leave an inline summary: advice and
  proposals explicitly say nothing was applied. Applied settings show the track,
  parameter, original value and formatted readback. Intended creative direction
  is not presented as a verified audible improvement. Plans, branches, knowledge
  and measurements keep JSON in collapsed technical details.
- Applied parameter, tempo, volume, pan and send settings each have a
  **Bypass / hear before** toggle, **Re-enable / hear after**, and separate
  **Revert this change** action. Bypass restores just the original setting;
  Revert closes that saved change and stops remaining steps in its plan.
  Other applied settings are untouched. Changes remain listed across new
  proposals. Recovery checks current session/device layout and setting value,
  refuses newer manual edits, and verifies readback; uncertain writes block
  recovery. Newer edits to the same setting must be reverted first.
  Structural/content operations (new tracks, scenes, devices, clips, notes and
  sample loads) explicitly have no safe automatic bypass/revert here. Studio
  never substitutes global Undo or disables an entire pre-existing device.
  Saved settings are in memory only and disappear when the panel closes or
  extensions reload; active Ableton edits are not reverted by closing Studio.
- Composer source warnings are visible. If no layers resolve, the panel marks
  the plan `needs_sources` and blocks its tempo-only preview. Configure local
  sample sources in LivePilot and regenerate; no samples are purchased by Studio.
  Existing-track native-instrument branches do not require new samples.

## Library and controls

- The Color theme selector lists every `.ask` palette from configured Ableton
  theme directories (including custom themes). Rescan picks up added files.
  Canvas input `themeDirectories` accepts absolute directory paths; no workspace
  path is hard-coded. Appearance changes apply to Studio only, not Ableton.
- Palettes are read locally; original theme files are never modified or copied.
  Text contrast is adjusted where necessary for readable controls.
- Select a module, choose a command, fill in its fields, and run it.
- Results show the real server response with a timestamp. Missing analyzer
  data and unavailable tools surface as errors, never simulated measurements.
- The architecture counts are documented baseline figures, not a live inventory.
- Library composition and knowledge consultation return plans, not automatic execution.
  Memory replay returns instructions and requires confirmation because it updates
  a replay counter. It does not automatically reconstruct a technique.
- Search all tools discovers additional server commands as reference documentation.
  Direct execution is limited to curated, validated module commands.

- Transport: play from start, stop, undo, redo, and tempo.
- Mixer: select a track, adjust volume/pan, or toggle mute/solo.
- Devices: select a device, filter its parameters, and edit within freshly read
  ranges. The displayed value uses Ableton's formatted units; numeric inputs use
  the device's raw range. Sliders apply on release; numeric inputs use Apply.
- Refresh reads session state without background polling. Refresh after changing
  the set or track/device layout in Ableton.

The extension uses `joinSession()` and `session.rpc.tools.execute()`; it does not
open another Ableton TCP connection or launch another MCP server. Commands follow
the current session's native permission pipeline.

Canvas ID: `livepilot-control`. Canvas actions: `catalog`, `refresh`, `creative-scan`,
`inspect-track`. Panel state is in memory only, reused
when the same instance is reopened, and discarded when closed or extensions are
reloaded. Appearance directory configuration and the selected theme ID are saved
atomically in `extension-data/livepilot-control/appearance.json` under
`COPILOT_HOME` (or `~/.copilot`). Settings include a validated format/version.
No Ableton session data is saved to disk.

Validation: `node --check extension.mjs standalone.mjs` and
`node --test ableton-app.test.mjs control.test.mjs creative.test.mjs themes.test.mjs standalone.test.mjs`.
