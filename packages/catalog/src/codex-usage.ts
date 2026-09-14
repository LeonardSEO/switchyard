import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@switchyard/core";

/**
 * Real Codex quota, read the way the Codex CLI itself reads it.
 *
 * The source is OpenAI's own usage endpoint, authenticated with the ChatGPT
 * login already stored by `codex login`. No third-party app, no browser
 * cookies, no scraping: just the credential the user already put on disk, on
 * macOS, Windows and Linux alike.
 *
 *   ~/.codex/auth.json   (or $CODEX_HOME/auth.json, or %USERPROFILE%\.codex)
 *     -> GET https://chatgpt.com/backend-api/wham/usage
 *
 * CodexBar and a manual file are fallbacks, not requirements. When nothing
 * works we report unknown: unknown quota is a state, never a zero.
 */

export interface UsageReading {
  usage?: Usage;
  /** Per-model availability, keyed by the upstream model name. */
  modelAvailability?: Record<string, boolean>;
  planType?: string;
  source: string;
  note: string;
}

export interface UsageSource {
  readonly id: string;
  read(): Promise<UsageReading>;
}

/** Where `codex login` stores the ChatGPT credential, per platform. */
export function codexAuthPath(): string {
  const base = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(base, "auth.json");
}

interface StoredAuth {
  auth_mode?: string;
  tokens?: { access_token?: string; account_id?: string; id_token?: string };
}

export class CodexAuthUsageSource implements UsageSource {
  readonly id = "codex-auth";

  constructor(
    private readonly opts: {
      authPath?: string;
      endpoint?: string;
      fetchFn?: typeof fetch;
      readAuth?: (path: string) => Promise<StoredAuth>;
    } = {},
  ) {}

  async read(): Promise<UsageReading> {
    const path = this.opts.authPath ?? codexAuthPath();
    let auth: StoredAuth;
    try {
      auth = this.opts.readAuth
        ? await this.opts.readAuth(path)
        : JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    } catch {
      return { source: this.id, note: `no codex login at ${path}` };
    }

    const token = auth.tokens?.access_token;
    if (!token) return { source: this.id, note: "codex login has no access token" };
    if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
      return { source: this.id, note: `auth mode ${auth.auth_mode} is not a ChatGPT login` };
    }

    const fetchFn = this.opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    const url = this.opts.endpoint ?? "https://chatgpt.com/backend-api/wham/usage";
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": "codex_cli_rs",
      };
      if (auth.tokens?.account_id) headers["chatgpt-account-id"] = auth.tokens.account_id;

      const res = await fetchFn(url, { headers });
      if (!res.ok) {
        return { source: this.id, note: `usage endpoint returned ${res.status}` };
      }
      return this.parse((await res.json()) as WhamUsage);
    } catch (err) {
      return { source: this.id, note: `usage request failed: ${(err as Error).message}` };
    }
  }

  private parse(body: WhamUsage): UsageReading {
    const w = body.rate_limit?.primary_window ?? body.rate_limit?.secondary_window;
    if (!w || w.used_percent === undefined) {
      return { source: this.id, note: "usage response has no rate limit window" };
    }
    const windowSeconds = w.limit_window_seconds ?? 604_800;
    const remainingFraction = Math.min(1, Math.max(0, 1 - w.used_percent / 100));
    const elapsed =
      w.reset_after_seconds === undefined
        ? 1 - remainingFraction
        : Math.min(1, Math.max(0, 1 - w.reset_after_seconds / windowSeconds));

    const modelAvailability: Record<string, boolean> = {};
    for (const [name, info] of Object.entries(body.model_usage ?? {})) {
      modelAvailability[name] = info?.available !== false;
    }

    return {
      usage: {
        remainingFraction,
        windowElapsedFraction: elapsed,
        resetsAtMs: w.reset_at === undefined ? undefined : w.reset_at * 1000,
        source: "codex-auth",
      },
      modelAvailability,
      planType: body.plan_type,
      source: this.id,
      note:
        `${Math.round(remainingFraction * 100)}% remaining, resets in ` +
        `${Math.round(((w.reset_after_seconds ?? 0) / 3600) * 10) / 10}h` +
        (body.plan_type ? `, plan ${body.plan_type}` : ""),
    };
  }
}

interface WhamUsage {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: Window;
    secondary_window?: Window;
  };
  model_usage?: Record<string, { available?: boolean } | null>;
}

interface Window {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

/** Optional: only used when it happens to be installed. */
export class CodexBarUsageSource implements UsageSource {
  readonly id = "codexbar";
  private readonly binary: string;
  private readonly provider: string;

  constructor(
    opts: {
      binary?: string;
      provider?: string;
      timeoutMs?: number;
      runner?: (args: string[]) => Promise<string>;
    } = {},
  ) {
    this.binary = opts.binary ?? "codexbar";
    this.provider = opts.provider ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.runner = opts.runner;
  }

  private readonly timeoutMs: number;
  private readonly runner?: (args: string[]) => Promise<string>;

  async read(): Promise<UsageReading> {
    try {
      const raw = this.runner
        ? await this.runner(["usage", "--provider", this.provider, "--format", "json"])
        : await this.exec();
      const parsed = JSON.parse(raw) as Array<{
        provider?: string;
        usage?: { primary?: Window | null; secondary?: Window | null };
      }>;
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const entry = entries.find((e) => (e.provider ?? "") === this.provider) ?? entries[0];
      const w = entry?.usage?.secondary ?? entry?.usage?.primary;
      if (!w || w.used_percent === undefined) {
        return { source: this.id, note: "codexbar returned no usage window" };
      }
      const remainingFraction = Math.min(1, Math.max(0, 1 - w.used_percent / 100));
      const windowMs = (w.limit_window_seconds ?? 604_800) * 1000;
      const resetsAtMs = w.reset_at === undefined ? undefined : w.reset_at * 1000;
      return {
        usage: {
          remainingFraction,
          windowElapsedFraction:
            resetsAtMs === undefined
              ? 1 - remainingFraction
              : Math.min(1, Math.max(0, 1 - (resetsAtMs - Date.now()) / windowMs)),
          resetsAtMs,
          source: "codexbar",
        },
        source: this.id,
        note: `${Math.round(remainingFraction * 100)}% remaining via codexbar`,
      };
    } catch (err) {
      return { source: this.id, note: `codexbar unavailable: ${(err as Error).message}` };
    }
  }

  private async exec(): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(
      this.binary,
      ["usage", "--provider", this.provider, "--format", "json"],
      { timeout: this.timeoutMs },
    );
    return String(stdout);
  }
}

/**
 * Manual override: `~/.switchyard/codex-usage.json`
 *   { "remainingFraction": 0.4, "windowElapsedFraction": 0.6, "resetsAtMs": 0 }
 * For CI, air-gapped machines, or when you simply want to say "assume 40%".
 */
export class ManualUsageFileSource implements UsageSource {
  readonly id = "file";

  constructor(private readonly path = join(homedir(), ".switchyard", "codex-usage.json")) {}

  async read(): Promise<UsageReading> {
    try {
      const parsed = JSON.parse(
        await (await import("node:fs/promises")).readFile(this.path, "utf8"),
      ) as Partial<Usage> & { modelAvailability?: Record<string, boolean> };
      if (parsed.remainingFraction === undefined || parsed.windowElapsedFraction === undefined) {
        return { source: this.id, note: "usage file incomplete" };
      }
      return {
        usage: {
          remainingFraction: parsed.remainingFraction,
          windowElapsedFraction: parsed.windowElapsedFraction,
          resetsAtMs: parsed.resetsAtMs,
          source: "file",
        },
        modelAvailability: parsed.modelAvailability,
        source: this.id,
        note: `from ${this.path}`,
      };
    } catch {
      return { source: this.id, note: "no usage file" };
    }
  }
}

/** Portable first, then whatever else exists, unknown last. Never invents data. */
export async function readCodexUsage(sources?: UsageSource[]): Promise<UsageReading> {
  const chain = sources ?? [
    new CodexAuthUsageSource(),
    new CodexBarUsageSource(),
    new ManualUsageFileSource(),
  ];
  const notes: string[] = [];
  for (const s of chain) {
    const reading = await s.read();
    if (reading.usage) return reading;
    notes.push(`${s.id}: ${reading.note}`);
  }
  return { source: "none", note: notes.join("; ") || "no usage source" };
}
