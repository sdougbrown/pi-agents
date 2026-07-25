import assert from "node:assert/strict";
import test from "node:test";
import {
  executionOverride,
  findPersistedProfileName,
  mergeAgentProfilesConfigs,
} from "../extensions/agents/agent-profile.ts";

test("mergeAgentProfilesConfigs merges project overrides by profile and agent", () => {
  assert.deepEqual(
    mergeAgentProfilesConfigs([
      {
        cloud: {
          description: "Cloud fallbacks",
          agents: {
            explore: { model: "sparky/deepseek-flash" },
            mule: { model: "sparky/deepseek-flash" },
          },
        },
      },
      {
        cloud: {
          agents: {
            explore: { model: "anthropic/claude-haiku" },
          },
        },
      },
    ]),
    {
      cloud: {
        description: "Cloud fallbacks",
        agents: {
          explore: { model: "anthropic/claude-haiku" },
          mule: { model: "sparky/deepseek-flash" },
        },
      },
    },
  );
});

test("mergeAgentProfilesConfigs ignores malformed profile values and reports them", () => {
  const errors: string[] = [];
  assert.deepEqual(
    mergeAgentProfilesConfigs([
      { cloud: null, local: { agents: "not-an-object" } },
      null,
    ], (message) => errors.push(message)),
    { local: { agents: {} } },
  );
  assert.deepEqual(errors, [
    'profile "cloud" must be an object',
    'profile "local" has a non-object agents value',
    "top-level value must be an object",
  ]);
});

test("executionOverride permits only model and thinkingLevel", () => {
  assert.deepEqual(
    executionOverride({
      model: "sparky/deepseek-flash",
      thinkingLevel: "high",
      systemPrompt: "Cannot replace the role prompt",
      tools: ["write"],
    }),
    { model: "sparky/deepseek-flash", thinkingLevel: "high" },
  );
  assert.equal(executionOverride({ thinkingLevel: "max" }), undefined);
});

test("findPersistedProfileName restores the latest selection and honors clear", () => {
  assert.equal(
    findPersistedProfileName([
      { type: "custom", customType: "pi-agents:profile", data: { name: "cloud" } },
      { type: "custom", customType: "other-extension", data: { name: "ignored" } },
      { type: "custom", customType: "pi-agents:profile", data: { name: "local" } },
    ]),
    "local",
  );

  assert.equal(
    findPersistedProfileName([
      { type: "custom", customType: "pi-agents:profile", data: { name: "cloud" } },
      { type: "custom", customType: "pi-agents:profile", data: { name: null } },
    ]),
    undefined,
  );
});
