import {
  effectiveInputPer1M,
  KeywordClassifier,
  ModelClassifier,
  defaultClassifierFloors,
  pickCheapestClassifier,
  rankClassifierCandidates,
  route,
  ClassificationCache,
  type Classification,
  type Classifier,
  type CompletionFn,
  type ModelCapabilities,
  type RoutingSignal,
  type TaskSpec,
} from "@vepando/switchyard-core";
import { createHash, randomUUID } from "node:crypto";
import type { Snapshot } from "@vepando/switchyard-catalog";
import { signalsFromCatalog } from "@vepando/switchyard-catalog";
import type {
  PiApiLike,
  PiBeforeAgentStartEventLike,
  PiContextLike,
  PiModelLike,
} from "./pi.js";
import { matchPiModel } from "./pi.js";
import { buildProjectContext } from "./project-context.js";
import { createPiCompletion } from "./completion.js";
import {
  appendOutcome,
  judgeRunStatus,
  outcomesPath,
  readOutcomes,
  signalsFromOutcomes,
  type OutcomeStatus,
} from "./outcomes.js";
import {
  clearClassificationCache,
  loadCache,
  loadFailures,
  loadLatencies,
  recordFailure,
  recordLatency,
  saveCache,
} from "./store.js";

export * from "./pi.js";
export * from "./outcomes.js";
export * from "./store.js";
export * from "./completion.js";
export * from "./project-context.js";

export interface AdapterOptions {
  /** Injectable for tests; defaults to the live snapshot builder. */
  loadSnapshot?: () => Promise<Snapshot>;
  outcomeFile?: string;
  /** Classification cache file; defaults to ~/.switchyard/classifier-cache.json */
  cacheFile?: string;
  /** Classifier latency file; defaults to ~/.switchyard/classifier-latency.json */
  latencyFile?: string;
  /** Failed-classifier file; defaults to ~/.switchyard/classifier-failures.json */
  failureFile?: string;
  /**
   * Pin the classifier model by id. Leave unset to let price, benchmark and
   * measured latency decide; set it when you have a model you trust and do not
   * want selection moving away from it.
   */
  classifierModel?: string;
  /** Tell the user what was chosen. Off in tests. */
  quiet?: boolean;
  /**
   * When to spend a classification call. Default "always" (measured 8/10 vs
   * 5/10 for keywords). Use "uncertain" to save the round trip, or "never" for
   * offline or private use where no objective should leave the machine.
   */
  escalation?: "always" | "uncertain" | "never";
  /**
   * Word-overlap above which the previous task's classification is reused for
   * this turn. Below the threshold the classifier runs again — one cheap, cached
   * call that decides which rung (and thus which price band) the turn routes to.
   * The default is deliberately strict: reusing a rung across dissimilar turns
   * is how a rename inherits "moderate" from the refactor before it and keeps
   * riding the same model. Set it lower to trade a little latency for accuracy.
   */
  reuseSimilarity?: number;
  /** Include compact codebase context in classification. Default "auto". */
  projectContext?: "auto" | "none";
  /** Refresh catalog and Codex capacity during long-running sessions. Default 10 minutes. */
  snapshotFreshnessMs?: number;
  /** Injectable clock for deterministic freshness tests. */
  now?: () => number;
  /** Route every turn, or only turns started through `switchyard/auto`. */
  routingScope?: "global" | "selected-model";
  /** What to do when core marks a route complex, high-risk, or ambiguous. Default: notify. */
  admissionPolicy?: "escalate" | "notify" | "ignore";
  /** Supply constraints Pi/OMP cannot infer, such as risk or a per-turn cost ceiling. */
  buildTaskSpec?: (
    event: PiBeforeAgentStartEventLike,
    ctx: PiContextLike,
  ) =>
    | Partial<Omit<TaskSpec, "objective" | "projectContext" | "projectScope">>
    | Promise<Partial<Omit<TaskSpec, "objective" | "projectContext" | "projectScope">>>;
}

/**
 * Classification reuse threshold. 0.3 was too permissive: coding turns share
 * enough function words to clear it by accident, so a moderate refactor's rung
 * stuck onto the next rename and the router kept sitting on the same model.
 * 0.6 still recognizes "still working on the same thing" without stretching it.
 */
export const DEFAULT_REUSE_SIMILARITY = 0.6;
export const DEFAULT_SNAPSHOT_FRESHNESS_MS = 10 * 60 * 1000;

interface PendingRun {
  runId: string;
  modelId: string;
  kind: string;
  complexity: string;
  effort: string;
  classifier?: string;
  projectScope?: string;
}

/**
 * Switchyard as a Pi extension.
 *
 * It does not become the coding agent. Pi keeps its permissions, tools, MCP,
 * sessions and authentication; this only answers "which model should take this
 * turn, and how hard should it think", then records what happened so the next
 * turn routes on evidence instead of on prices alone.
 */
export function createExtension(opts: AdapterOptions = {}) {
  return (pi: PiApiLike): void => {
    let snapshotPromise: Promise<Snapshot> | undefined;
    let snapshotLoadedAt = 0;
    let availableCache: PiModelLike[] = [];
    let pending: PendingRun | undefined;
    let lastRun: PendingRun | undefined;
    let lastMarkedStatus: OutcomeStatus | undefined;
    let selectedRoutingActive = false;
    let applyingDecision = false;
    let selectedAutoModel: PiModelLike | undefined;
    let agentRunning = false;
    let latestEvent: PiBeforeAgentStartEventLike | undefined;
    let latestContext: PiContextLike | undefined;
    // Most sessions spend many turns on one task. Classifying the same task
    // again every turn is the latency users actually feel, so the rung is
    // reused while the objective is still recognisably the same task.
    let lastObjective: string | undefined;
    let lastClassification: Classification | undefined;
    let lastProjectContext: string | undefined;
    let classifierPromise: Promise<Classifier> | undefined;
    let cacheWritePromise: Promise<void> = Promise.resolve();
    const projectContextPromises = new Map<string, Promise<string>>();
    const now = opts.now ?? Date.now;
    const freshnessMs = opts.snapshotFreshnessMs ?? DEFAULT_SNAPSHOT_FRESHNESS_MS;
    const routingScope =
      opts.routingScope ??
      (process.env.SWITCHYARD_ROUTING_SCOPE === "selected-model" ? "selected-model" : "global");

    if (routingScope === "selected-model") {
      pi.registerProvider?.("switchyard", {
        // `switchyard/auto` is a control model. before_agent_start replaces it
        // with the routed target before a provider request is made.
        baseUrl: "http://127.0.0.1:8787/v1",
        apiKey: "switchyard-control-model",
        api: "openai-completions",
        models: [
          {
            id: "auto",
            name: "Switchyard Auto",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 100_000,
          },
        ],
      });
    }

    pi.registerCommand?.("switchyard-clear-cache", {
      description: "Clear cached Switchyard task classifications",
      handler: async (_args, ctx) => {
        try {
          // Let an in-flight cache write finish before deleting the file, or it
          // could recreate the cache immediately after this command returns.
          await cacheWritePromise.catch(() => undefined);
          await clearClassificationCache(opts.cacheFile);
          classifierPromise = undefined;
          lastObjective = undefined;
          lastClassification = undefined;
          lastProjectContext = undefined;
          projectContextPromises.clear();
          ctx.ui?.notify?.("Switchyard classification cache cleared.", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui?.notify?.(`Could not clear Switchyard classification cache: ${message}`, "error");
        }
      },
    });

    const registerOutcomeCommand = (
      name: string,
      description: string,
      status: Extract<OutcomeStatus, "verified_success" | "failed">,
    ) => {
      pi.registerCommand?.(name, {
        description,
        handler: async (_args, ctx) => {
          if (!lastRun) {
            ctx.ui?.notify?.("Switchyard has no completed run to mark.", "error");
            return;
          }
          if (lastMarkedStatus === status) {
            ctx.ui?.notify?.("That Switchyard outcome is already recorded.", "info");
            return;
          }
          await appendOutcome(
            { ...lastRun, status, at: now() },
            opts.outcomeFile ?? outcomesPath(),
          );
          lastMarkedStatus = status;
          ctx.ui?.notify?.(
            status === "verified_success"
              ? "Switchyard recorded the last run as verified successful."
              : "Switchyard recorded the last run as failed.",
            "info",
          );
        },
      });
    };

    registerOutcomeCommand(
      "switchyard-mark-success",
      "Mark the last Switchyard run as verified successful",
      "verified_success",
    );
    registerOutcomeCommand(
      "switchyard-mark-failure",
      "Mark the last Switchyard run as failed",
      "failed",
    );

    /**
     * The classifier escalates to a cheap model only when the deterministic
     * answer is uncertain, so most turns cost nothing extra. It borrows Pi's
     * credentials rather than introducing an API key of its own.
     */
    const getClassifier = (ctx: PiContextLike, snap: Snapshot): Promise<Classifier> => {
      if (!classifierPromise) {
        classifierPromise = (async () => {
          const candidates = snap.models.filter(
            (m) => m.pricing.kind === "api" || m.pricing.kind === "local",
          );
          const latencies = await loadLatencies(opts.latencyFile);
          const failed = await loadFailures(opts.failureFile);
          // Below ~0.5 the models guess rather than follow the schema, and the
          // rung they pick is what every other decision hangs on.
          const picked = pickCheapestClassifier(candidates, {
            ...defaultClassifierFloors,
            minCapabilityScore: 0.5,
            // Nearly everything capable is a reasoning model now; the call
            // itself switches reasoning off rather than excluding them.
            allowReasoning: true,
            latencyMs: (m) => latencies[m.id],
            avoid: (m) => failed[m.id] !== undefined,
          });
          // An explicitly pinned model wins over price and latency.
          const pinned = opts.classifierModel
            ? candidates.find((m) => m.id === opts.classifierModel)
            : undefined;
          const chosen = pinned ?? picked;
          if (!chosen) return new KeywordClassifier();
          const backups = rankClassifierCandidates(
            candidates,
            {
              ...defaultClassifierFloors,
              minCapabilityScore: 0.5,
              allowReasoning: true,
              latencyMs: (m) => latencies[m.id],
              avoid: (m) => failed[m.id] !== undefined,
            },
            // Five model candidates before a degraded keyword answer: a dead
            // catalog entry must cost one round trip, not give up the rung.
            5,
          ).slice(1);

          const cache = new Map(Object.entries(await loadCache(opts.cacheFile)));
          const diskCache = {
            get: (task: { kind?: string; objective: string }) =>
              cache.get(ClassificationCache.key(task as never)),
            set: (task: { kind?: string; objective: string }, value: Classification) => {
              cache.set(ClassificationCache.key(task as never), value);
              const snapshot = Object.fromEntries(cache);
              cacheWritePromise = cacheWritePromise
                .catch(() => undefined)
                .then(() => saveCache(snapshot, opts.cacheFile));
            },
          };

          return new ModelClassifier({
            models: candidates,
            cache: diskCache as never,
            complete: timedCompletion(ctx, chosen, opts.latencyFile, pinned ? [] : backups, opts.failureFile),
            modelId: chosen.id,
            // Measured on a held-out set: keyword 2/12, model 11/12. The rung
            // decides every other decision, so it is worth one round trip —
            // cached on disk, latency-tracked, and degrading to the keyword
            // answer if the call fails.
            escalation: opts.escalation ?? "always",
            minSavingsFactor: 0,
          });
        })();
      }
      return classifierPromise;
    };

    const load = (): Promise<Snapshot> => {
      if (!snapshotPromise || now() - snapshotLoadedAt >= freshnessMs) {
        snapshotLoadedAt = now();
        snapshotPromise = (opts.loadSnapshot
          ? opts.loadSnapshot()
          : import("@vepando/switchyard-catalog").then((m) => m.buildSnapshot()))
          .catch((error) => {
            snapshotPromise = undefined;
            snapshotLoadedAt = 0;
            throw error;
          });
      }
      return snapshotPromise;
    };

    const routeTurn = async (
      event: PiBeforeAgentStartEventLike,
      ctx: PiContextLike,
      bypassScope = false,
    ) => {
      const objective = event?.prompt?.trim();
      if (!objective || objective.length < 3) return;

      if (routingScope === "selected-model" && !bypassScope) {
        if (isSwitchyardAuto(ctx.model)) {
          selectedRoutingActive = true;
          selectedAutoModel = ctx.model;
        }
        if (!selectedRoutingActive) return;
      }

      let projectContext = "";
      const cwd = event.systemPromptOptions?.cwd ?? ctx.cwd ?? process.cwd();
      if (opts.projectContext !== "none") {
        const loadedContextFiles = event.systemPromptOptions?.contextFiles ?? [];
        const contextFilesKey = loadedContextFiles
          .map((file) => `${file.path ?? ""}:${file.content ?? ""}`)
          .join("\u0000");
        const projectContextKey = `${cwd}\u0000${contextFilesKey}`;
        let projectContextPromise = projectContextPromises.get(projectContextKey);
        if (!projectContextPromise) {
          projectContextPromise = buildProjectContext(cwd, loadedContextFiles);
          projectContextPromises.set(projectContextKey, projectContextPromise);
        }
        projectContext = await projectContextPromise.catch(() => "");
      }

      let snapshot: Snapshot;
      try {
        snapshot = await load();
      } catch {
        return; // No catalog, no opinion: leave Pi's model alone.
      }

      availableCache = ctx.modelRegistry?.getAvailable?.() ?? [];
      const routable: ModelCapabilities[] = [];
      const piModelByModelId = new Map<string, PiModelLike>();
      for (const m of snapshot.models) {
        const found = matchPiModel(m, availableCache);
        if (found) {
          routable.push(m);
          piModelByModelId.set(m.id, found);
        }
      }
      if (routable.length === 0) return;

      const hostContextTokens = ctx.getContextUsage?.().tokens ?? undefined;
      const hostTools = event.systemPromptOptions?.selectedTools;
      const supplied = await Promise.resolve(opts.buildTaskSpec?.(event, ctx)).catch(() => ({}));
      const task: TaskSpec = {
        ...(hostContextTokens === undefined ? {} : { contextTokens: hostContextTokens }),
        ...(hostTools?.length ? { requiredTools: hostTools } : {}),
        ...supplied,
        objective,
        projectContext: projectContext || undefined,
        projectScope: projectScopeFor(cwd),
      };

      let classification: Classification;
      const threshold = opts.reuseSimilarity ?? DEFAULT_REUSE_SIMILARITY;
      const reuse =
        lastClassification &&
        lastObjective &&
        lastProjectContext === projectContext &&
        taskSimilarity(lastObjective, objective) >= threshold;
      if (reuse && lastClassification) {
        classification = { ...lastClassification, source: "model" };
      } else {
        classification = await getClassifier(ctx, snapshot).then((c) =>
          c.classify(task),
        );
        // A provider/auth/HTTP failure degrades to the local classifier. That
        // keeps this turn working, but it must not become a reusable session
        // result; the persistent classifier cache already follows this rule.
        if (!classification.degraded) {
          lastObjective = objective;
          lastClassification = classification;
          lastProjectContext = projectContext;
        } else {
          lastObjective = undefined;
          lastClassification = undefined;
          lastProjectContext = undefined;
        }
      }
      const outcomes = await readOutcomes(opts.outcomeFile);
      const signals: Record<string, RoutingSignal> = {
        ...signalsFromCatalog(snapshot.models),
        ...signalsFromOutcomes(outcomes, { now: now() }),
      };

      const decision = routeSafely(
        task,
        routable,
        classification,
        snapshot,
        signals,
        opts.admissionPolicy ?? "notify",
      );
      if (!decision) return;

      const target = piModelByModelId.get(decision.modelId);
      if (!target) return;

      pending = {
        runId: randomUUID(),
        modelId: decision.modelId,
        kind: decision.kind,
        complexity: decision.complexity,
        effort: decision.effort,
        classifier:
          classification.degraded
            ? `${classification.source}:degraded`
            : reuse
              ? `${classification.source}:reused`
              : classification.source,
        projectScope: task.projectScope,
      };

      try {
        applyingDecision = true;
        await pi.setThinkingLevel(decision.effort);
        const ok = await pi.setModel(target);
        if (!ok) {
          pending = undefined;
          return;
        }
      } catch {
        pending = undefined;
        return;
      } finally {
        applyingDecision = false;
      }

      if (!opts.quiet) {
        ctx.ui?.notify?.(
          `switchyard → ${decision.modelId} (${decision.complexity}, effort ${decision.effort}${
            decision.price === undefined ? "" : `, $${decision.price.toFixed(3)}/M`
          }${decision.admissionAction ? `, ${decision.admissionAction}` : ""})`,
          "info",
        );
      }
    };

    pi.on("before_agent_start", async (event: PiBeforeAgentStartEventLike, ctx: PiContextLike) => {
      latestEvent = event;
      latestContext = ctx;
      await routeTurn(event, ctx);
    });

    pi.on("agent_start", () => {
      agentRunning = true;
    });

    pi.on("model_select", async (event: { model?: PiModelLike }) => {
      if (routingScope !== "selected-model" || applyingDecision) return;
      selectedRoutingActive = isSwitchyardAuto(event.model);
      selectedAutoModel = selectedRoutingActive ? event.model : undefined;
      // OMP prewalk can hand off after the agent has already started. Route
      // that handoff immediately so the control model is never sent upstream.
      if (selectedRoutingActive && agentRunning && latestEvent && latestContext) {
        await routeTurn(latestEvent, latestContext, true);
      }
    });

    pi.on("agent_end", async (event: { messages?: unknown[] }) => {
      agentRunning = false;
      if (!pending) return;
      const run = pending;
      pending = undefined;
      lastRun = run;
      lastMarkedStatus = undefined;
      await appendOutcome(
        {
          ...run,
          status: judgeRunStatus(event?.messages ?? []),
          at: now(),
        },
        opts.outcomeFile ?? outcomesPath(),
      );

      if (routingScope === "selected-model" && selectedRoutingActive && selectedAutoModel) {
        try {
          applyingDecision = true;
          await pi.setModel(selectedAutoModel);
        } finally {
          applyingDecision = false;
        }
      }
    });
  };
}

function isSwitchyardAuto(model: PiModelLike | undefined): boolean {
  return model?.provider === "switchyard" && model.id === "auto";
}

/** Stable local scope without writing the user's project path to telemetry. */
export function projectScopeFor(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/**
 * Word-overlap between two objectives. Cheap, local, and good enough to tell
 * "still working on the same thing" from "moved on to something else".
 */
export function taskSimilarity(a: string, b: string): number {
  const words = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function routeSafely(
  task: TaskSpec,
  routable: ModelCapabilities[],
  classification: Classification,
  snapshot: Snapshot,
  signals: Record<string, RoutingSignal>,
  admissionPolicy: "escalate" | "notify" | "ignore",
) {
  try {
    const decision = route(
      task,
      routable,
      classification,
      { capacity: snapshot.capacity, signals },
    );
    if (!decision.model) return undefined;
    let selected = decision.model;
    let admissionAction: string | undefined;
    if (decision.admissionRequired && admissionPolicy === "escalate") {
      const selectedCapability = selected.capabilityScore ?? 0;
      const stronger = decision.ranked
        .filter((candidate) => (candidate.model.capabilityScore ?? 0) > selectedCapability)
        .sort(
          (a, b) =>
            (a.model.capabilityScore ?? Number.POSITIVE_INFINITY) -
            (b.model.capabilityScore ?? Number.POSITIVE_INFINITY),
        )[0]?.model;
      if (stronger) {
        selected = stronger;
        admissionAction = `admission escalated from ${decision.model.id}`;
      } else {
        admissionAction = "admission required; no stronger runnable model";
      }
    } else if (decision.admissionRequired && admissionPolicy === "notify") {
      admissionAction = "admission required";
    }
    const price = effectiveInputPer1M(selected, snapshot.capacity[selected.id]);
    return {
      modelId: selected.id,
      kind: decision.kind,
      complexity: decision.complexity,
      effort: decision.effort,
      price: price.known ? price.value : undefined,
      admissionRequired: decision.admissionRequired,
      admissionAction,
      reason: decision.reason,
    };
  } catch {
    return undefined;
  }
}

/** Wraps the completion to record latency, so slow classifiers get replaced. */
function timedCompletion(
  ctx: PiContextLike,
  primary: ModelCapabilities,
  latencyFile?: string,
  backups: ModelCapabilities[] = [],
  failureFile?: string,
): CompletionFn {
  const inner = createPiCompletion(ctx);
  return async (req) => {
    let lastError: unknown;
    for (const model of [primary, ...backups]) {
      const started = Date.now();
      try {
        const res = await inner({ ...req, model });
        void recordLatency(model.id, Date.now() - started, latencyFile);
        return res;
      } catch (err) {
        lastError = err;
        void recordLatency(model.id, Date.now() - started, latencyFile);
        void recordFailure(model.id, failureFile);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("classifier unavailable");
  };
}

export default createExtension();
