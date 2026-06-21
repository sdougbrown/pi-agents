# @dougbots/pi-agents

Agent profiles for pi — preconfigured model, system prompt, tool restrictions, and permission gates.

## What it does

Defines named agent profiles (mirroring opencode's `agent` concept) that can be:
- Activated on the current session: `/agent jockey`
- Booted at startup: `PI_AGENT=reviewer pi`
- Spawned by [avenor](https://github.com/sdougbrown/avenor) as pi subprocesses: `avenor_spawn(agent: "reviewer", backend: "pi")`

## Install

```bash
# As a pi package (recommended)
pi install git:github.com/sdougbrown/pi-agents

# Local development
pi install /path/to/pi-agents
```

## Config

`~/.pi/agent/agents.json` (global) and `.pi/agents.json` (project, overrides global):

```json
{
  "reviewer": {
    "description": "Code reviewer — no edits",
    "model": "provider/model-id",
    "systemPrompt": "inline text or file:/path/to/prompt.md",
    "thinkingLevel": "high",
    "excludeTools": ["write", "edit"],
    "permissions": {
      "bash": {
        "allow": ["git *", "npm test *"],
        "deny": ["git push*", "rm -rf*"]
      }
    }
  }
}
```

Profile fields:
- `model` — `"provider/model-id"` (required)
- `systemPrompt` — inline string or `file:/absolute/path` (required)
- `thinkingLevel` — `off` | `low` | `medium` | `high` | `xhigh`
- `tools` — allowlist of tool names (if set, only these are callable)
- `excludeTools` — denylist of tool names (removed from available set)
- `permissions.bash` — `{ allow?: string[], deny?: string[] }` with glob patterns

## Commands

| Command | Description |
|---------|-------------|
| `/agent <name>` | Switch current session to agent profile |
| `/agent none` | Deactivate agent, restore all tools |
| `/agent` | List available agents |
| `/agents` | Same as `/agent` |

## Boot with agent

```bash
PI_AGENT=reviewer pi
PI_AGENT=jockey pi -c
```

## Avenor integration

When `avenor_spawn(agent: "reviewer", backend: "pi")` is called, avenor spawns `pi --mode rpc` with `PI_AGENT=reviewer`. The agents extension applies the full profile (model, systemPrompt, tools, permissions) automatically.

Requires [avenor](https://github.com/sdougbrown/avenor) with the pi backend (v0.3.3+). Model resolution falls back to `~/.pi/agent/agents.json` when the agent is not found in opencode config.

## Profile vs. agent

`pi-profiles` (by Carter McAlister) is a session config overlay — it swaps settings/extensions/skills and reloads the current session. Agents are discrete "personalities" with their own model, prompt, tool restrictions, and permission gates, designed to be spawned as subprocesses by avenor.

## Dependencies

- **pi** — the extension runtime
- **avenor** — for subprocess spawning with `backend: "pi"` (optional, for sub-agent workflows)
  - best used with `@dougbots/avenor-pi` to provide the tools to spawn those processes
