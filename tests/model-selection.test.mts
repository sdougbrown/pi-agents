import assert from "node:assert/strict";
import test from "node:test";
import {
  findCliModelOverride,
  findCliThinkingOverride,
  parseModelSpecifier,
} from "../extensions/agents/model-selection.ts";

test("findCliModelOverride returns the model passed to pi", () => {
  assert.equal(
    findCliModelOverride(["--mode", "rpc", "--model", "anthropic/claude-opus-4", "--no-session"]),
    "anthropic/claude-opus-4",
  );
});

test("findCliModelOverride ignores a missing --model value", () => {
  assert.equal(findCliModelOverride(["--mode", "rpc", "--model"]), undefined);
  assert.equal(findCliModelOverride(["--mode", "rpc"]), undefined);
});

test("findCliThinkingOverride returns the thinking level passed to pi", () => {
  assert.equal(
    findCliThinkingOverride(["--mode", "rpc", "--model", "openai-codex/gpt-6-astra", "--thinking", "high"]),
    "high",
  );
});

test("findCliThinkingOverride ignores a missing --thinking value", () => {
  assert.equal(findCliThinkingOverride(["--mode", "rpc", "--thinking"]), undefined);
  assert.equal(findCliThinkingOverride(["--mode", "rpc", "--model", "openai-codex/gpt-6-astra"]), undefined);
});

test("parseModelSpecifier preserves slashes in model IDs", () => {
  assert.deepEqual(parseModelSpecifier("openrouter/anthropic/claude-sonnet-4"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
  });
});

test("parseModelSpecifier rejects incomplete model specifiers", () => {
  assert.equal(parseModelSpecifier("claude-sonnet-4"), undefined);
  assert.equal(parseModelSpecifier("/claude-sonnet-4"), undefined);
  assert.equal(parseModelSpecifier("anthropic/"), undefined);
});
