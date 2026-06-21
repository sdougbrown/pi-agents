import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
/*  Config loading — merges global (~/.pi/agent/agents.json)           */
/*  with project (.pi/agents.json), project wins.                      */
/* ------------------------------------------------------------------ */

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
  // Later entries override earlier — project wins over global
  return configs.reduce<AgentsConfig>((merged, cfg) => ({ ...merged, ...cfg }), {});
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
  // Deny wins over allow
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
  let activeAgent: { name: string; profile: AgentProfile } | null = null;

  /* ---- Apply agent profile to the current session ---- */
  async function applyAgent(name: string, ctx: ExtensionContext): Promise<boolean> {
    const profile = agents[name];
    if (!profile) {
      ctx.ui.notify(`Agent "${name}" not found in agents.json`, "error");
      return false;
    }

    // Resolve model
    const [provider, modelId] = profile.model.split("/");
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`Model "${profile.model}" not found in registry`, "error");
      return false;
    }
    await pi.setModel(model);

    // Thinking level
    if (profile.thinkingLevel) {
      pi.setThinkingLevel(profile.thinkingLevel);
    }

    // Tool restrictions — best-effort against currently registered tools.
    // tool_call handler enforces restrictions regardless of registration timing.
    try {
      const allTools = pi.getAllTools();
      let allowed: typeof allTools;
      if (profile.tools) {
        // Allowlist: only these tool names
        allowed = allTools.filter((t) => profile.tools!.includes(t.name));
        // Also include any future tools whose name matches (checked at call time)
      } else {
        allowed = [...allTools];
      }
      if (profile.excludeTools) {
        allowed = allowed.filter((t) => !profile.excludeTools!.includes(t.name));
      }
      pi.setActiveTools(allowed.map((t) => t.name));
    } catch {
      // setActiveTools may fail if called too early; tool_call gate is the fallback
    }

    activeAgent = { name, profile };
    ctx.ui.setStatus("agent", `agent:${name}`);
    ctx.ui.notify(`Agent "${name}" active${profile.description ? ": " + profile.description : ""}`, "info");
    return true;
  }

  /* ---- Deactivate agent ---- */
  function deactivateAgent(ctx: ExtensionContext) {
    activeAgent = null;
    try {
      pi.setActiveTools(pi.getAllTools().map((t) => t.name));
    } catch { /* no-op if tools not fully registered */ }
    ctx.ui.setStatus("agent", "");
    ctx.ui.notify("Agent deactivated — all tools restored", "info");
  }

  /* ---- session_start: apply PI_AGENT env var ---- */
  pi.on("session_start", async (_event, ctx) => {
    const envAgent = process.env.PI_AGENT;
    if (envAgent && agents[envAgent]) {
      await applyAgent(envAgent, ctx);
    }
  });

  /* ---- before_agent_start: inject agent system prompt ---- */
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!activeAgent) return undefined;

    // Re-apply tool restrictions each turn (catches late-registered tools)
    try {
      const profile = activeAgent.profile;
      const allTools = pi.getAllTools();
      let allowed: typeof allTools;
      if (profile.tools) {
        allowed = allTools.filter((t) => profile.tools.includes(t.name));
      } else {
        allowed = [...allTools];
      }
      if (profile.excludeTools) {
        allowed = allowed.filter((t) => !profile.excludeTools.includes(t.name));
      }
      pi.setActiveTools(allowed.map((t) => t.name));
    } catch { /* best effort */ }

    const agentPrompt = resolveSystemPrompt(activeAgent.profile.systemPrompt);
    return {
      systemPrompt: agentPrompt + "\n\n" + event.systemPrompt,
    };
  });

  /* ---- tool_call: enforce tool allowlist/denylist + bash permissions ---- */
  pi.on("tool_call", async (event, ctx) => {
    if (!activeAgent) return;
    const profile = activeAgent.profile;

    // Tool allowlist gate
    if (profile.tools && !profile.tools.includes(event.toolName)) {
      return { block: true, reason: `Tool "${event.toolName}" not allowed for agent "${activeAgent.name}"` };
    }

    // Tool denylist gate
    if (profile.excludeTools && profile.excludeTools.includes(event.toolName)) {
      ctx.ui.notify(`Blocked tool: ${event.toolName}`, "warning");
      return { block: true, reason: `Tool "${event.toolName}" excluded for agent "${activeAgent.name}"` };
    }

    // Bash permission gate
    if (event.toolName === "bash" && profile.permissions?.bash) {
      const command = (event.input as { command?: string })?.command ?? "";
      const verdict = checkBashPermission(profile.permissions.bash, command);
      if (verdict === "deny") {
        ctx.ui.notify(`Blocked: ${command.slice(0, 80)}`, "warning");
        return { block: true, reason: `Denied by ${activeAgent.name} bash permissions` };
      }
    }
  });

  /* ---- /agent <name> — switch to an agent profile ---- */
  pi.registerCommand("agent", {
    description: "Switch to an agent profile (or 'none' to deactivate)",
    getArgumentCompletions: (prefix) => {
      const matches = Object.keys(agents).filter((n) => n.startsWith(prefix ?? ""));
      return matches.length
        ? matches.map((n) => ({
            value: n,
            label: n,
            description: agents[n].description ?? "",
          }))
        : null;
    },
    handler: async (args, ctx) => {
      const name = args?.trim();
      if (!name) {
        const current = activeAgent ? ` (active: ${activeAgent.name})` : "";
        const list = Object.entries(agents)
          .map(([n, p]) => `  ${n}${p.description ? ": " + p.description : ""}`)
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
        .map(([n, p]) => `  ${n}${p.description ? ": " + p.description : ""}`)
        .join("\n");
      ctx.ui.notify(`Agent profiles${current}:\n${list}`, "info");
    },
  });
}
