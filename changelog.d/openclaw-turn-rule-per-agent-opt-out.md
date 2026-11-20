**An OpenClaw agent opted out with `--no-instructions --workspace <dir>` no longer gets the per-turn GBrain rule.**

### Fixed
- `gbrain setup openclaw --instructions-only --no-instructions --workspace <dir>` now rewrites the gateway-wide `gbrain-turn-rule` plugin to skip that workspace. It used to leave the plugin unchanged, so the agent kept getting the GBrain rule on every turn. The plugin skips each opted-out workspace and each agent that openclaw.json assigns to one, matched on the hook context's `agentId` or `workspaceDir`. Every later setup run keeps that list. `--instructions --workspace <dir>` takes the workspace off it again.
