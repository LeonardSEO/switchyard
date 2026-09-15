import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface OpenCodeAuthEntry {
  type?: unknown;
  key?: unknown;
}

interface ResolveOpenRouterApiKeyOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  readTextFile?: (path: string) => Promise<string>;
}

/** Resolve OpenCode's documented local credential store without exposing its contents. */
export async function resolveOpenRouterApiKey(
  options: ResolveOpenRouterApiKeyOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const explicit = env.OPENROUTER_API_KEY?.trim();
  if (explicit) return explicit;

  const dataDirectory = env.XDG_DATA_HOME?.trim() || join(options.homeDirectory ?? homedir(), ".local", "share");
  const authFile = join(dataDirectory, "opencode", "auth.json");

  try {
    const raw = await (options.readTextFile ?? ((path) => readFile(path, "utf8")))(authFile);
    const auth = JSON.parse(raw) as Record<string, OpenCodeAuthEntry>;
    const openrouter = auth.openrouter;
    return openrouter?.type === "api" && typeof openrouter.key === "string" && openrouter.key.trim()
      ? openrouter.key.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
