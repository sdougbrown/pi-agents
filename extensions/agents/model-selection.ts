export interface ModelSpecifier {
  provider: string;
  modelId: string;
}

/**
 * Return the value pi received for a built-in flag, if any.
 *
 * Pi consumes its built-in flags itself, so extension flags cannot expose
 * these values via pi.getFlag(). Inspecting argv lets agent profiles respect
 * normal CLI precedence, including the model and thinking level Avenor
 * forwards from a roster entry.
 */
function findCliFlagValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag) return argv[index + 1];
  }
  return undefined;
}

/** Return the model explicitly supplied to pi, if any. */
export function findCliModelOverride(argv: readonly string[]): string | undefined {
  return findCliFlagValue(argv, "--model");
}

/** Return the thinking level explicitly supplied to pi, if any. */
export function findCliThinkingOverride(argv: readonly string[]): string | undefined {
  return findCliFlagValue(argv, "--thinking");
}

/** Split provider/model-id at the first slash so model IDs may contain slashes. */
export function parseModelSpecifier(specifier: string): ModelSpecifier | undefined {
  const separator = specifier.indexOf("/");
  if (separator <= 0 || separator === specifier.length - 1) return undefined;

  return {
    provider: specifier.slice(0, separator),
    modelId: specifier.slice(separator + 1),
  };
}
