import type { RoutingSignal } from "@vepando/switchyard-core";

/**
 * Outcome store. This is what turns cold-start guessing into routing on
 * evidence: the corpus benchmark showed 6/10 cold against 6/6 warm, and warm
 * only exists because outcomes were recorded somewhere.
 *
 * Deliberately boring: one append-only JSONL file, no schema migrations, no
 * database. It is read at the start of every turn and never blocks routing.
 */

export interface Outcome {
  /** Correlates completion telemetry with a later explicit verification. */
  runId?: string;
  modelId: string;
  kind: string;
  complexity: string;
  effort?: string;
  /** Which classifier decided the rung: keyword, model, explicit, or degraded. */
  classifier?: string;
  /** New records distinguish technical completion from verified correctness. */
  status?: OutcomeStatus;
  /** Legacy v0.3.4-and-earlier field, retained while old JSONL files are read. */
  success?: boolean;
  at: number;
}

export type OutcomeStatus = "completed" | "verified_success" | "failed";

const MAX_RECORDS = 5_000;

export function outcomesPath(home = process.env.HOME ?? "."): string {
  return `${home}/.switchyard/outcomes.jsonl`;
}

export async function appendOutcome(outcome: Outcome, path = outcomesPath()): Promise<void> {
  try {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(outcome)}\n`, "utf8");
  } catch {
    // Losing an outcome is not worth breaking a turn over.
  }
}

export async function readOutcomes(path = outcomesPath()): Promise<Outcome[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines
      .slice(-MAX_RECORDS)
      .map((line) => {
        try {
          return JSON.parse(line) as Outcome;
        } catch {
          return undefined;
        }
      })
      .filter((o): o is Outcome => !!o);
  } catch {
    return [];
  }
}

/**
 * Per (model, kind) success rates. A model that fails at debugging is still the
 * right choice for summarising, so the key keeps them apart.
 */
export function signalsFromOutcomes(outcomes: Outcome[]): Record<string, RoutingSignal> {
  const finalOutcomes = new Map<string, Outcome>();
  outcomes.forEach((outcome, index) => {
    finalOutcomes.set(outcome.runId ?? `legacy:${index}`, outcome);
  });
  const tally = new Map<string, { ok: number; total: number }>();
  for (const o of finalOutcomes.values()) {
    const status = outcomeStatus(o);
    // A clean agent-loop completion says nothing about whether the requested
    // code is correct. Only explicit verification and explicit failure teach.
    if (status === "completed") continue;
    const key = `${o.modelId}|${o.kind}`;
    const t = tally.get(key) ?? { ok: 0, total: 0 };
    t.total += 1;
    if (status === "verified_success") t.ok += 1;
    tally.set(key, t);
  }
  const signals: Record<string, RoutingSignal> = {};
  for (const [key, t] of tally) {
    signals[key] = { successRate: t.ok / t.total, rejectRate: 0 };
  }
  return signals;
}

function outcomeStatus(outcome: Outcome): OutcomeStatus {
  if (outcome.status) return outcome.status;
  // Old `success: true` records only prove that the turn ended normally. Old
  // explicit failures remain useful evidence.
  return outcome.success === false ? "failed" : "completed";
}

/** Backward-compatible technical-completion check. This does not verify correctness. */
export function judgeRun(messages: unknown[]): boolean {
  return judgeRunStatus(messages) === "completed";
}

/** Classify transport/agent-loop completion without claiming code correctness. */
export function judgeRunStatus(messages: unknown[]): OutcomeStatus {
  if (!Array.isArray(messages) || messages.length === 0) return "failed";
  let hasAssistantMessage = false;
  for (const message of messages) {
    const m = message as { role?: string; stopReason?: string; errorMessage?: string };
    if (m.role !== "assistant") continue;
    hasAssistantMessage = true;
    if (m.errorMessage) return "failed";
    if (m.stopReason === "error" || m.stopReason === "aborted" || m.stopReason === "length") {
      return "failed";
    }
  }
  return hasAssistantMessage ? "completed" : "failed";
}
