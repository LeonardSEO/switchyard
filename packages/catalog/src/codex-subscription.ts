import type { CapacityState, ModelCapabilities, Usage } from "@vepando/switchyard-core";

/**
 * Codex subscription capacity (ChatGPT Plus/Pro).
 *
 * There is no public catalog for these models: the Codex CLI talks to OpenAI's
 * backend with the user's ChatGPT login and exposes no model list. So the
 * roster is declared here, is user-overridable, and capacity is reported as
 * unknown unless the login is actually detected. Never assume it is free.
 */

export interface CodexModelSpec {
  id: string;
  displayName: string;
  tier: ModelCapabilities["tier"];
  /** Amortized plan price, USD per 1M tokens. The calibration knob. */
  amortizedPer1M: number;
  maxContextTokens: number;
  strengths: ModelCapabilities["strengths"];
  weaknesses?: ModelCapabilities["weaknesses"];
  /**
   * Declared, not measured: OpenAI publishes no benchmark for these models.
   * Without a score they are treated as mediocre and lose every risky task to
   * a measured API model, which is the wrong default for capacity we already
   * pay for. History corrects these numbers once runs accumulate.
   */
  declaredCapability?: number;
}

export const defaultCodexModels: CodexModelSpec[] = [
  {
    id: "codex-luna",
    displayName: "Luna",
    tier: "mid",
    amortizedPer1M: 0.3,
    maxContextTokens: 200_000,
    declaredCapability: 0.5,
    strengths: ["code-change", "refactor", "summarize", "extract"],
    weaknesses: ["plan"],
  },
  {
    id: "codex-terra",
    displayName: "Terra",
    tier: "mid",
    amortizedPer1M: 0.35,
    maxContextTokens: 400_000,
    declaredCapability: 0.6,
    strengths: ["code-change", "debug", "refactor", "review"],
  },
  {
    id: "codex-sol",
    displayName: "Sol",
    tier: "large",
    amortizedPer1M: 0.5,
    maxContextTokens: 400_000,
    declaredCapability: 0.72,
    strengths: ["code-change", "debug", "plan", "review", "refactor"],
  },
  {
    id: "codex-astra",
    displayName: "Astra",
    tier: "large",
    amortizedPer1M: 0.8,
    maxContextTokens: 1_000_000,
    declaredCapability: 0.8,
    strengths: ["plan", "debug", "review", "code-change"],
  },
];

export interface CodexEnvironment {
  /** True when a `codex` binary is on PATH. */
  hasBinary: boolean;
  /** True when a stored ChatGPT login exists (CODEX_HOME/auth.json). */
  hasLogin: boolean;
}

export async function detectCodexEnvironment(
  opts: { codexHome?: string; lookPath?: (bin: string) => Promise<string | null> } = {},
): Promise<CodexEnvironment> {
  const home = process.env.HOME ?? ".";
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? `${home}/.codex`;
  const { access } = await import("node:fs/promises");
  const lookPath =
    opts.lookPath ??
    (async (bin: string) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      try {
        const { stdout } = await promisify(execFile)("which", [bin]);
        return String(stdout).trim() || null;
      } catch {
        return null;
      }
    });
  const hasBinary = (await lookPath("codex")) !== null;
  let hasLogin = false;
  try {
    await access(`${codexHome}/auth.json`);
    hasLogin = true;
  } catch {
    hasLogin = false;
  }
  return { hasBinary, hasLogin };
}

export interface CodexSourceOptions {
  /** Measured quota, when a usage source could read it. */
  usage?: Usage;
  /** Models the usage endpoint reports as unavailable right now. */
  unavailableIds?: string[];
}

export class CodexSubscriptionSource {
  readonly id = "codex-subscription";

  constructor(
    private readonly models: CodexModelSpec[] = defaultCodexModels,
    private readonly env: CodexEnvironment = { hasBinary: false, hasLogin: false },
    private readonly opts: CodexSourceOptions = {},
  ) {}

  /**
   * A detected login is not proof of remaining quota. With a usage reading we
   * report the measured window; without one, capacity stays unknown rather than
   * assumed full.
   */
  list(): { models: ModelCapabilities[]; capacity: Record<string, CapacityState> } {
    const usable = this.env.hasBinary && this.env.hasLogin;
    const blocked = new Set(this.opts.unavailableIds ?? []);
    const capacity: Record<string, CapacityState> = {};
    const models = this.models.map<ModelCapabilities>((m) => {
      capacity[m.id] = !usable
        ? { available: false, reason: "codex CLI or ChatGPT login not detected" }
        : blocked.has(m.id)
          ? { available: false, reason: "usage endpoint reports this model unavailable" }
          : this.opts.usage
            ? { available: true, usage: this.opts.usage }
            : { available: "unknown", reason: "logged in; quota not measured" };
      return {
        id: m.id,
        provider: this.id,
        displayName: m.displayName,
        tier: m.tier,
        capabilityScore: m.declaredCapability,
        capabilityScoreSource: m.declaredCapability === undefined ? undefined : "declared",
        maxContextTokens: m.maxContextTokens,
        strengths: m.strengths,
        weaknesses: m.weaknesses,
        pricing: {
          kind: "subscription",
          inputPer1M: { known: false },
          outputPer1M: { known: false },
          planAmortizedPer1M: { known: true, value: m.amortizedPer1M },
        },
      };
    });
    return { models, capacity };
  }
}
