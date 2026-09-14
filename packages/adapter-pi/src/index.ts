import {
  effectiveInputPer1M,
  KeywordClassifier,
  ModelClassifier,
  defaultClassifierFloors,
  pickCheapestClassifier,
  route,
  type Classification,
  type Classifier,
  type ModelCapabilities,
  type RoutingSignal,
} from "@switchyard/core";
import type { Snapshot } from "@switchyard/catalog";
import { signalsFromCatalog } from "@switchyard/catalog";
import type { PiApiLike, PiContextLike, PiModelLike } from "./pi";
import { matchPiModel } from "./pi";
import { createPiCompletion } from "./completion";
import { appendOutcome, judgeRun, outcomesPath, readOutcomes, signalsFromOutcomes } from "./outcomes";

export * from "./pi";
export * from "./outcomes";

export interface AdapterOptions {
  /** Injectable for tests; defaults to the live snapshot builder. */
  loadSnapshot?: () => Promise<Snapshot>;
  outcomeFile?: string;
  /** Tell the user what was chosen. Off in tests. */
  quiet?: boolean;
}

interface PendingRun {
  modelId: string;
  kind: string;
  complexity: string;
  effort: string;
  classifier?: string;
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
    let availableCache: PiModelLike[] = [];
    let pending: PendingRun | undefined;
    let classifierPromise: Promise<Classifier> | undefined;

    /**
     * The classifier escalates to a cheap model only when the deterministic
     * answer is uncertain, so most turns cost nothing extra. It borrows Pi's
     * credentials rather than introducing an API key of its own.
     */
    const getClassifier = (ctx: PiContextLike, snap: Snapshot): Promise<Classifier> => {
      if (!classifierPromise) {
        classifierPromise = (async () => {
          const apiModels = snap.models.filter((m) => m.pricing.kind === "api");
          // Below ~0.5 the models guess rather than follow the schema, and the
          // rung they pick is what every other decision hangs on.
          const picked = pickCheapestClassifier(apiModels, {
            ...defaultClassifierFloors,
            minCapabilityScore: 0.5,
            // Nearly everything capable is a reasoning model now; the call
            // itself switches reasoning off rather than excluding them.
            allowReasoning: true,
          });
          if (!picked) return new KeywordClassifier();
          return new ModelClassifier({
            models: apiModels,
            complete: createPiCompletion(ctx),
            modelId: picked.id,
          });
        })();
      }
      return classifierPromise;
    };

    const load = (): Promise<Snapshot> => {
      if (!snapshotPromise) {
        snapshotPromise = opts.loadSnapshot
          ? opts.loadSnapshot()
          : import("@switchyard/catalog").then((m) => m.buildSnapshot());
      }
      return snapshotPromise;
    };

    pi.on("before_agent_start", async (event: { prompt?: string }, ctx: PiContextLike) => {
      const objective = event?.prompt?.trim();
      if (!objective || objective.length < 3) return;

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

      const classification = await getClassifier(ctx, snapshot).then((c) =>
        c.classify({ objective }),
      );
      const outcomes = await readOutcomes(opts.outcomeFile);
      const signals: Record<string, RoutingSignal> = {
        ...signalsFromCatalog(snapshot.models),
        ...signalsFromOutcomes(outcomes),
      };

      const decision = routeSafely(objective, routable, classification, snapshot, signals);
      if (!decision) return;

      const target = piModelByModelId.get(decision.modelId);
      if (!target) return;

      pending = {
        modelId: decision.modelId,
        kind: decision.kind,
        complexity: decision.complexity,
        effort: decision.effort,
        classifier: classification.degraded
          ? `${classification.source}:degraded`
          : classification.source,
      };

      try {
        await pi.setThinkingLevel(decision.effort);
        const ok = await pi.setModel(target);
        if (!ok) {
          pending = undefined;
          return;
        }
      } catch {
        pending = undefined;
        return;
      }

      if (!opts.quiet) {
        ctx.ui?.notify?.(
          `switchyard → ${decision.modelId} (${decision.complexity}, effort ${decision.effort}${
            decision.price === undefined ? "" : `, $${decision.price.toFixed(3)}/M`
          })`,
          "info",
        );
      }
    });

    pi.on("agent_end", async (event: { messages?: unknown[] }) => {
      if (!pending) return;
      const run = pending;
      pending = undefined;
      await appendOutcome(
        {
          modelId: run.modelId,
          kind: run.kind,
          complexity: run.complexity,
          effort: run.effort,
          classifier: run.classifier,
          success: judgeRun(event?.messages ?? []),
          at: Date.now(),
        },
        opts.outcomeFile ?? outcomesPath(),
      );
    });
  };
}

function routeSafely(
  objective: string,
  routable: ModelCapabilities[],
  classification: Classification,
  snapshot: Snapshot,
  signals: Record<string, RoutingSignal>,
) {
  try {
    const decision = route(
      { objective },
      routable,
      classification,
      { capacity: snapshot.capacity, signals },
    );
    if (!decision.model) return undefined;
    const price = effectiveInputPer1M(decision.model, snapshot.capacity[decision.model.id]);
    return {
      modelId: decision.model.id,
      kind: decision.kind,
      complexity: decision.complexity,
      effort: decision.effort,
      price: price.known ? price.value : undefined,
    };
  } catch {
    return undefined;
  }
}

export default createExtension();
