export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Runtime-safe fields a named agent-profile may override on a base agent. */
export interface AgentProfileOverride {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentProfileSet {
  description?: string;
  agents?: Record<string, AgentProfileOverride>;
}

export interface AgentProfilesConfig {
  [name: string]: AgentProfileSet;
}

const thinkingLevels = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Discard unsupported fields from untrusted JSON config. */
export function executionOverride(value: unknown): AgentProfileOverride | undefined {
  if (!isRecord(value)) return undefined;
  const override: AgentProfileOverride = {};
  if (typeof value.model === "string") override.model = value.model;
  if (typeof value.thinkingLevel === "string" && thinkingLevels.has(value.thinkingLevel as ThinkingLevel)) {
    override.thinkingLevel = value.thinkingLevel as ThinkingLevel;
  }
  return Object.keys(override).length ? override : undefined;
}

/**
 * Merge profile config sources: project entries override global entries by
 * profile and agent name. Invalid JSON shapes are ignored rather than making
 * the extension fail to load.
 */
export function mergeAgentProfilesConfigs(
  configs: readonly unknown[],
  onInvalid?: (message: string) => void,
): AgentProfilesConfig {
  const merged: AgentProfilesConfig = {};

  for (const config of configs) {
    if (!isRecord(config)) {
      onInvalid?.("top-level value must be an object");
      continue;
    }

    for (const [name, rawProfile] of Object.entries(config)) {
      if (!isRecord(rawProfile)) {
        onInvalid?.(`profile "${name}" must be an object`);
        continue;
      }
      if (rawProfile.agents !== undefined && !isRecord(rawProfile.agents)) {
        onInvalid?.(`profile "${name}" has a non-object agents value`);
      }
      if (rawProfile.description !== undefined && typeof rawProfile.description !== "string") {
        onInvalid?.(`profile "${name}" has a non-string description`);
      }

      const current = Object.hasOwn(merged, name) ? merged[name] : undefined;
      const rawAgents = isRecord(rawProfile.agents) ? rawProfile.agents : {};
      const profile: AgentProfileSet = {
        ...(typeof current?.description === "string" ? { description: current.description } : {}),
        ...(typeof rawProfile.description === "string" ? { description: rawProfile.description } : {}),
        agents: {
          ...current?.agents,
          ...rawAgents as Record<string, AgentProfileOverride>,
        },
      };

      // defineProperty avoids the __proto__ setter on normal objects and makes
      // profile-name lookups consistently own-property-only.
      Object.defineProperty(merged, name, {
        value: profile,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  return merged;
}

/** Return the latest persisted profile selection, including an explicit clear. */
export function findPersistedProfileName(entries: readonly unknown[]): string | undefined {
  let profileName: string | undefined;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const customEntry = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (customEntry.type !== "custom" || customEntry.customType !== "pi-agents:profile") continue;
    if (!customEntry.data || typeof customEntry.data !== "object") continue;

    const name = (customEntry.data as { name?: unknown }).name;
    if (typeof name === "string") profileName = name;
    if (name === null) profileName = undefined;
  }

  return profileName;
}
