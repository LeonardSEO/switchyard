import { readFile } from "node:fs/promises";
import { defaultCodexModels, type CodexModelSpec } from "./codex-subscription";

/**
 * The Codex subscription roster is the one list we cannot fetch — OpenAI
 * publishes no catalog for the models behind a ChatGPT login. So it is declared,
 * and it is overridable: when OpenAI renames Luna or ships something new, drop a
 * JSON file and the router follows. No code change, no release.
 *
 *   ~/.switchyard/codex-models.json   [ { id, displayName, tier, amortizedPer1M, ... } ]
 */
export async function loadCodexModels(
  path = `${process.env.HOME ?? "."}/.switchyard/codex-models.json`,
): Promise<{ models: CodexModelSpec[]; source: "override" | "default" }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { models: defaultCodexModels, source: "default" };
    }
    const models = parsed.filter(isCodexModelSpec);
    if (models.length === 0) return { models: defaultCodexModels, source: "default" };
    return { models, source: "override" };
  } catch {
    return { models: defaultCodexModels, source: "default" };
  }
}

function isCodexModelSpec(v: unknown): v is CodexModelSpec {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.id === "string" && typeof m.amortizedPer1M === "number";
}
