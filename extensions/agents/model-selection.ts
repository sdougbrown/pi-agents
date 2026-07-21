export interface ModelSpecifier {
  provider: string;
  modelId: string;
}

/**
 * Return the model explicitly supplied to pi, if any.
 *
 * Pi consumes --model itself, so extension flags cannot expose this value via
 * pi.getFlag(). Inspecting argv lets agent profiles respect normal CLI
 * precedence, including models forwarded by Avenor.
 */
export function findCliModelOverride(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === "--model") return argv[index + 1];
  }
  return undefined;
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
