# Copilot Workspace Instructions

Follow the root `AGENTS.md` for project rules. For the map of AI clients,
committed versus local configuration, MCP startup, and sync destinations,
read [`docs/manual/ai-workspace-baseline.md`](../docs/manual/ai-workspace-baseline.md).

Do not treat a configured MCP server as connected. LivePilot's workspace
server needs a local checkout and its `.venv`; a GitHub virtual-filesystem
workspace cannot launch that local Python process. Check MCP server status
before claiming LivePilot tools are available.