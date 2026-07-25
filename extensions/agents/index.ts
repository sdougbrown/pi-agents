import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  executionOverride,
  findPersistedProfileName,
  mergeAgentProfilesConfigs,
  type AgentProfilesConfig,
  type ThinkingLevel,
} from "./agent-profile.ts";
import { findCliModelOverride, parseModelSpecifier } from "./model-selection.ts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BashPermissions {
  allow?: string[];
  deny?: string[];
}

interface AgentProfile {
  description?: string;
  model: string;              // "provider/model-id"
  systemPrompt: string;       // inline text or "file:/absolute/path/to/prompt.md"
  thinkingLevel?: ThinkingLevel;
  tools?: string[];           // allowlist — if set, only these tools are callable
  excludeTools?: string[];    // denylist — removed from available tools
  permissions?: {
    bash?: BashPermissions;
  };
}

interface AgentsConfig {
  [name: string]: AgentProfile;
}

/* ------------------------------------------------------------------ */
/*  Config loading                                                     */
/* ------------------------------------------------------------------ */

/** Merge global ~/.pi/agent/agents.json with project .pi/agents.json. */
function loadAgentsConfig(): AgentsConfig {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "agents.json");
  const projectPath = join(process.cwd(), ".pi", "agents.json");

  const configs: AgentsConfig[] = [];
  for (const [label, path] of [
    ["global", globalPath],
    ["project", projectPath],
  ] as const) {
    if (!existsSync(path)) continue;
    try {
      configs.push(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      console.error(`[agents] Failed to parse ${label} agents.json (${path}):`, err);
    }
  }
  // Later entries override earlier — project wins over global.
  return configs.reduce<AgentsConfig>((merged, cfg) => ({ ...merged, ...cfg }), {});
}

/**
 * Load named runtime overlays. These can change only execution settings,
 * leaving an agent's prompt, tools, and permission boundary authoritative.
 */
function loadAgentProfilesConfig(): { profiles: AgentProfilesConfig; errors: string[] } {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "agent-profiles.json");
  const projectPath = join(process.cwd(), ".pi", "agent-profiles.json");

  let profiles: AgentProfilesConfig = {};
  const errors: string[] = [];
  for (const [label, path] of [
    ["global", globalPath],
    ["project", projectPath],
  ] as const) {
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      profiles = mergeAgentProfilesConfigs([profiles, config], (message) => {
        errors.push(`${label} ${path}: ${message}`);
      });
    } catch (err) {
      const message = `Failed to parse ${label} agent-profiles.json (${path}): ${String(err)}`;
      console.error(`[agents] ${message}`);
      errors.push(message);
    }
  }
  return { profiles, errors };
}

function resolveSystemPrompt(raw: string): string {
  if (raw.startsWith("file:")) {
    const path = raw.slice(5);
    if (!existsSync(path)) {
      throw new Error(`Agent system prompt file not found: ${path}`);
    }
    return readFileSync(path, "utf8");
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/*  Bash permission matching (simple glob: * = anything)               */
/* ------------------------------------------------------------------ */

function matchPattern(pattern: string, command: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(command);
}

function checkBashPermission(
  perms: BashPermissions | undefined,
  command: string,
): "allow" | "deny" {
  if (!perms) return "allow";
  // Deny wins over allow.
  for (const pattern of perms.deny ?? []) {
    if (matchPattern(pattern, command)) return "deny";
  }
  for (const pattern of perms.allow ?? []) {
    if (matchPattern(pattern, command)) return "allow";
  }
  // If allow list exists but no match, deny. If only deny list, allow.
  return perms.allow ? "deny" : "allow";
}

/* ------------------------------------------------------------------ */
/*  Extension                                                          */
/* ------------------------------------------------------------------ */

export default async function (pi: ExtensionAPI) {
  const agents = loadAgentsConfig();
  const { profiles: agentProfiles, errors: agentProfileConfigErrors } = loadAgentProfilesConfig();
  // Built-in flags are not exposed through pi.getFlag(). Avenor forwards its
  // model option to pi as --model, so argv is the extension-level signal that
  // the caller's model should take precedence over the profile default.
  const cliModelOverride = findCliModelOverride(process.argv.slice(2));
  let activeAgent: { name: string; profile: AgentProfile } | null = null;
  let activeAgentProfileName: string | undefined;

  function getEffectiveAgentProfile(name: string): AgentProfile | undefined {
    const base = agents[name];
    if (!base) return undefined;

    const override = activeAgentProfileName
      ? executionOverride(agentProfiles[activeAgentProfileName]?.agents?.[name])
      : undefined;
    return { ...base, ...override };
  }

  function setAgentProfileStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "agent-profile",
      activeAgentProfileName ? `agent-profile:${activeAgentProfileName}` : "",
    );
  }

  /** Apply a named agent-profile, optionally saving the choice in this session. */
  async function selectAgentProfile(
    name: string | undefined,
    ctx: ExtensionContext,
    persist: boolean,
  ): Promise<boolean> {
    if (name && !agentProfiles[name]) {
      ctx.ui.notify(`Agent profile "${name}" not found in agent-profiles.json`, "error");
      return false;
    }

    const previousName = activeAgentProfileName;
    activeAgentProfileName = name;
    setAgentProfileStatus(ctx);

    // The active role must receive a new effective model/thinking level now;
    // future roles resolve the overlay when /agent is invoked. Do not persist
    // a selection that cannot be applied to the current active role.
    if (activeAgent && !(await applyAgent(activeAgent.name, ctx))) {
      activeAgentProfileName = previousName;
      setAgentProfileStatus(ctx);
      return false;
    }

    if (persist) pi.appendEntry("pi-agents:profile", { name: name ?? null });
    return true;
  }

  /* ---- Apply agent profile to the current session ---- */
  async function applyAgent(name: string, ctx: ExtensionContext): Promise<boolean> {
    const profile = getEffectiveAgentProfile(name);
    if (!profile) {
      ctx.ui.notify(`Agent "${name}" not found in agents.json`, "error");
      return false;
    }

    // Explicit CLI selection wins over the profile default. This preserves
    // `avenor_spawn(agent: ..., model: ..., backend: "pi")` overrides because
    // Avenor forwards model to the pi subprocess as --model.
    if (!cliModelOverride) {
      const modelSpecifier = parseModelSpecifier(profile.model);
      if (!modelSpecifier) {
        ctx.ui.notify(`Invalid model "${profile.model}"; expected provider/model-id`, "error");
        return false;
      }

      const model = ctx.modelRegistry.find(modelSpecifier.provider, modelSpecifier.modelId);
      if (!model) {
        ctx.ui.notify(`Model "${profile.model}" not found in registry`, "error");
        return false;
      }
      await pi.setModel(model);
    }

    if (profile.thinkingLevel) pi.setThinkingLevel(profile.thinkingLevel);

    // Tool restrictions — best-effort against currently registered tools.
    // tool_call handler enforces restrictions regardless of registration timing.
    try {
      const allTools = pi.getAllTools();
      let allowed: typeof allTools;
      if (profile.tools) {
        allowed = allTools.filter((tool) => profile.tools!.includes(tool.name));
      } else {
        allowed = [...allTools];
      }
      if (profile.excludeTools) {
        allowed = allowed.filter((tool) => !profile.excludeTools!.includes(tool.name));
      }
      pi.setActiveTools(allowed.map((tool) => tool.name));
    } catch {
      // setActiveTools may fail if called too early; tool_call gate is the fallback.
    }

    activeAgent = { name, profile };
    ctx.ui.setStatus("agent", `agent:${name}`);
    const selected = activeAgentProfileName ? ` [${activeAgentProfileName}]` : "";
    ctx.ui.notify(
      `Agent "${name}" active${selected}${profile.description ? ": " + profile.description : ""}`,
      "info",
    );
    return true;
  }

  /* ---- Deactivate agent ---- */
  function deactivateAgent(ctx: ExtensionContext) {
    activeAgent = null;
    try {
      pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
    } catch { /* no-op if tools not fully registered */ }
    ctx.ui.setStatus("agent", "");
    ctx.ui.notify("Agent deactivated — all tools restored", "info");
  }

  /* ---- session_start: restore profile, then apply PI_AGENT ---- */
  pi.on("session_start", async (_event, ctx) => {
    if (agentProfileConfigErrors.length) {
      ctx.ui.notify(
        `Ignored malformed agent-profile configuration:\n${agentProfileConfigErrors.join("\n")}`,
        "warning",
      );
    }

    // The environment is an explicit launch-time override. A persisted command
    // selection is restored otherwise, including a saved `none` selection.
    const environmentProfile = process.env.PI_AGENT_PROFILE ?? process.env.PROFILE;
    const persistedProfile = findPersistedProfileName(ctx.sessionManager.getEntries());
    const selectedProfile = environmentProfile ?? persistedProfile;
    if (selectedProfile) await selectAgentProfile(selectedProfile, ctx, false);
    else setAgentProfileStatus(ctx);

    const envAgent = process.env.PI_AGENT;
    if (envAgent && agents[envAgent]) await applyAgent(envAgent, ctx);
  });

  /* ---- before_agent_start: inject agent system prompt ---- */
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!activeAgent) return undefined;

    // Re-apply tool restrictions each turn (catches late-registered tools).
    try {
      const profile = activeAgent.profile;
      const allTools = pi.getAllTools();
      let allowed: typeof allTools;
      if (profile.tools) {
        allowed = allTools.filter((tool) => profile.tools.includes(tool.name));
      } else {
        allowed = [...allTools];
      }
      if (profile.excludeTools) {
        allowed = allowed.filter((tool) => !profile.excludeTools.includes(tool.name));
      }
      pi.setActiveTools(allowed.map((tool) => tool.name));
    } catch { /* best effort */ }

    const agentPrompt = resolveSystemPrompt(activeAgent.profile.systemPrompt);
    return { systemPrompt: agentPrompt + "\n\n" + event.systemPrompt };
  });

  /* ---- tool_call: enforce tool allowlist/denylist + bash permissions ---- */
  pi.on("tool_call", async (event, ctx) => {
    if (!activeAgent) return;
    const profile = activeAgent.profile;

    if (profile.tools && !profile.tools.includes(event.toolName)) {
      return { block: true, reason: `Tool "${event.toolName}" not allowed for agent "${activeAgent.name}"` };
    }

    if (profile.excludeTools && profile.excludeTools.includes(event.toolName)) {
      ctx.ui.notify(`Blocked tool: ${event.toolName}`, "warning");
      return { block: true, reason: `Tool "${event.toolName}" excluded for agent "${activeAgent.name}"` };
    }

    if (event.toolName === "bash" && profile.permissions?.bash) {
      const command = (event.input as { command?: string })?.command ?? "";
      if (checkBashPermission(profile.permissions.bash, command) === "deny") {
        ctx.ui.notify(`Blocked: ${command.slice(0, 80)}`, "warning");
        return { block: true, reason: `Denied by ${activeAgent.name} bash permissions` };
      }
    }
  });

  /* ---- /agent <name> — switch to an agent profile ---- */
  pi.registerCommand("agent", {
    description: "Switch to an agent profile (or 'none' to deactivate)",
    getArgumentCompletions: (prefix) => {
      const matches = Object.keys(agents).filter((name) => name.startsWith(prefix ?? ""));
      return matches.length
        ? matches.map((name) => ({
            value: name,
            label: name,
            description: agents[name].description ?? "",
          }))
        : null;
    },
    handler: async (args, ctx) => {
      const name = args?.trim();
      if (!name) {
        const current = activeAgent ? ` (active: ${activeAgent.name})` : "";
        const list = Object.entries(agents)
          .map(([agentName, profile]) => `  ${agentName}${profile.description ? ": " + profile.description : ""}`)
          .join("\n");
        ctx.ui.notify(`Agent profiles${current}:\n${list}`, "info");
        return;
      }
      if (name === "none") {
        deactivateAgent(ctx);
        return;
      }
      await applyAgent(name, ctx);
    },
  });

  /* ---- /agents — list profiles ---- */
  pi.registerCommand("agents", {
    description: "List available agent profiles",
    handler: async (_args, ctx) => {
      const current = activeAgent ? ` [active: ${activeAgent.name}]` : "";
      const list = Object.entries(agents)
        .map(([name, profile]) => `  ${name}${profile.description ? ": " + profile.description : ""}`)
        .join("\n");
      ctx.ui.notify(`Agent profiles${current}:\n${list}`, "info");
    },
  });

  /* ---- /agent-profile <name> — select a session-scoped runtime overlay ---- */
  pi.registerCommand("agent-profile", {
    description: "Select a session-scoped agent runtime profile (or 'none' to clear)",
    getArgumentCompletions: (prefix) => {
      const names = ["none", ...Object.keys(agentProfiles)];
      const matches = names.filter((name) => name.startsWith(prefix ?? ""));
      return matches.length
        ? matches.map((name) => ({
            value: name,
            label: name,
            description: name === "none"
              ? "Clear the session agent profile"
              : agentProfiles[name]?.description ?? "",
          }))
        : null;
    },
    handler: async (args, ctx) => {
      const name = args?.trim();
      if (!name) {
        const current = activeAgentProfileName ?? "none";
        const list = Object.entries(agentProfiles)
          .map(([profileName, profile]) => `  ${profileName}${profile.description ? ": " + profile.description : ""}`)
          .join("\n");
        ctx.ui.notify(`Agent runtime profiles (active: ${current})${list ? `:\n${list}` : ""}`, "info");
        return;
      }
      await selectAgentProfile(name === "none" ? undefined : name, ctx, true);
    },
  });
}
