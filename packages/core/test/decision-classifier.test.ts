import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION_CACHE_TTL_MS,
  DEFAULT_DECISION_FAILURE_COOLDOWN_MS,
  DecisionClassifier,
  type DecisionChoiceAnswer,
  type DecisionFn,
  type DecisionRequest,
  type DecisionResponse,
} from "../src/decision-classifier.js";
import {
  MAX_OBJECTIVE_CHARS,
  MAX_PROJECT_CONTEXT_CHARS,
  type Classification,
  type Classifier,
} from "../src/classifier.js";
import type { TaskSpec } from "../src/types.js";

function choice(value: string, confidence: number): DecisionChoiceAnswer {
  return {
    type: "choice",
    choice: value,
    probabilities: { [value]: confidence },
    confidence,
  };
}

function throwingClassifier(): Classifier {
  return {
    classify: async () => {
      throw new Error("fallback must not run");
    },
  };
}

function fixedClassifier(classification: Classification): Classifier {
  return { classify: async () => classification };
}

function responseFor(
  request: DecisionRequest,
  overrides: Partial<Record<"task_kind" | "task_complexity", DecisionChoiceAnswer>> = {},
): DecisionResponse {
  const answers: Record<string, DecisionChoiceAnswer> = {};
  if (request.questions.task_kind) {
    answers.task_kind = overrides.task_kind ?? choice("code-change", 0.9);
  }
  if (request.questions.task_complexity) {
    answers.task_complexity = overrides.task_complexity ?? choice("moderate", 0.8);
  }
  return { model: "typesafe/jev-1.13", answers };
}

const task: TaskSpec = { objective: "Investigate a parser regression across several files" };

function createClassifier(
  overrides: Partial<ConstructorParameters<typeof DecisionClassifier>[0]> = {},
): DecisionClassifier {
  const decide: DecisionFn = async (request) => responseFor(request);
  return new DecisionClassifier({
    model: "typesafe/jev-latest",
    decide,
    fallback: fixedClassifier({
      kind: "debug",
      complexity: "moderate",
      confidence: 0.8,
      source: "model",
    }),
    ...overrides,
  });
}

describe("DecisionClassifier", () => {
  it("uses an accepted Jev decision for missing task fields", async () => {
    const requests: DecisionRequest[] = [];
    const classifier = new DecisionClassifier({
      model: "typesafe/jev-latest",
      decide: async (request) => {
        requests.push(request);
        return {
          model: "typesafe/jev-1.13",
          answers: {
            task_kind: choice("debug", 0.91),
            task_complexity: choice("complex", 0.84),
          },
          costUsd: 0.000042,
        };
      },
      fallback: throwingClassifier(),
    });

    await expect(
      classifier.classify({ objective: "Trace a race across two services" }),
    ).resolves.toMatchObject({
      kind: "debug",
      complexity: "complex",
      confidence: 0.84,
      source: "jev",
      classifierModel: "typesafe/jev-1.13",
      costUsd: 0.000042,
    });
    expect(requests[0]?.model).toBe("typesafe/jev-latest");
  });

  it.each([
    ["kind", { kind: "review" as const }, ["task_complexity"]],
    ["complexity", { complexity: "advanced" as const }, ["task_kind"]],
  ])("preserves explicit %s and asks only for the missing field", async (_, explicit, expected) => {
    const decide = vi.fn(async (request: DecisionRequest) => responseFor(request));
    const result = await createClassifier({ decide }).classify({
      objective: "Assess this patch",
      ...explicit,
    });

    expect(Object.keys(decide.mock.calls[0]?.[0].questions ?? {})).toEqual(expected);
    expect(result).toMatchObject(explicit);
  });

  it("does not call a remote classifier when both fields are explicit", async () => {
    const decide = vi.fn<DecisionFn>();
    const result = await createClassifier({ decide }).classify({
      objective: "Apply the requested edit",
      kind: "code-change",
      complexity: "simple",
    });

    expect(decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "code-change",
      complexity: "simple",
      confidence: 1,
      source: "explicit",
    });
  });

  it.each([
    ["low confidence", choice("moderate", 0.49), "low-confidence"],
    ["unknown choice", choice("impossible", 0.9), "invalid-response"],
    [
      "invalid probability",
      { ...choice("moderate", 0.9), probabilities: { moderate: 1.2 } },
      "invalid-response",
    ],
  ] as const)("falls back on %s", async (_, complexityAnswer, reason) => {
    const decide = async (request: DecisionRequest): Promise<DecisionResponse> =>
      responseFor(request, { task_complexity: complexityAnswer });
    const result = await createClassifier({ decide }).classify(task);

    expect(result).toMatchObject({
      source: "model",
      fallbackFrom: "jev",
      fallbackReason: reason,
    });
  });

  it("falls back when a requested answer is missing", async () => {
    const result = await createClassifier({
      decide: async () => ({
        model: "typesafe/jev-1.13",
        answers: { task_kind: choice("debug", 0.9) },
      }),
    }).classify(task);

    expect(result).toMatchObject({
      source: "model",
      fallbackFrom: "jev",
      fallbackReason: "invalid-response",
    });
  });

  it("keeps classification local when escalation is never", async () => {
    const decide = vi.fn<DecisionFn>();
    const result = await createClassifier({ decide, escalation: "never" }).classify(task);

    expect(decide).not.toHaveBeenCalled();
    expect(result.source).toBe("keyword");
  });

  it("calls Jev only near a local boundary when escalation is uncertain", async () => {
    const decide = vi.fn(async (request: DecisionRequest) => responseFor(request));
    const classifier = createClassifier({ decide, escalation: "uncertain" });

    const stable = await classifier.classify({ objective: "create a simple hello world page" });
    const boundary = await classifier.classify({ objective: "deploy" });

    expect(stable.source).toBe("keyword");
    expect(boundary.source).toBe("jev");
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("bounds objective and project context sent to Jev", async () => {
    const requests: DecisionRequest[] = [];
    await createClassifier({
      decide: async (request) => {
        requests.push(request);
        return responseFor(request);
      },
    }).classify({
      objective: "o".repeat(MAX_OBJECTIVE_CHARS + 100),
      projectContext: "p".repeat(MAX_PROJECT_CONTEXT_CHARS + 100),
    });

    expect(requests[0]?.state.objective).toHaveLength(MAX_OBJECTIVE_CHARS);
    expect(requests[0]?.state.objective.endsWith("\n[truncated]")).toBe(true);
    expect(requests[0]?.state.project_context).toHaveLength(MAX_PROJECT_CONTEXT_CHARS);
    expect(requests[0]?.state.project_context?.endsWith("\n[truncated]")).toBe(true);
  });

  it("uses the minimum confidence and ignores an invalid cost", async () => {
    const result = await createClassifier({
      decide: async (request) => ({
        ...responseFor(request, {
          task_kind: choice("debug", 0.93),
          task_complexity: choice("complex", 0.71),
        }),
        costUsd: Number.NaN,
      }),
    }).classify(task);

    expect(result).toMatchObject({ confidence: 0.71, source: "jev" });
    expect(result).not.toHaveProperty("costUsd");
  });

  it("falls back after a transport failure and bypasses Jev during cooldown", async () => {
    let now = 10_000;
    const decide = vi.fn<DecisionFn>().mockRejectedValue(new Error("upstream unavailable"));
    const classifier = createClassifier({ decide, now: () => now });

    const failed = await classifier.classify(task);
    now += DEFAULT_DECISION_FAILURE_COOLDOWN_MS - 1;
    const coolingDown = await classifier.classify({ objective: `${task.objective} again` });

    expect(failed).toMatchObject({ fallbackFrom: "jev", fallbackReason: "unavailable" });
    expect(coolingDown).toMatchObject({ fallbackFrom: "jev", fallbackReason: "cooldown" });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("returns degraded keyword classification when the fallback throws", async () => {
    const result = await createClassifier({
      decide: async () => {
        throw new Error("Jev unavailable");
      },
      fallback: throwingClassifier(),
    }).classify(task);

    expect(result).toMatchObject({
      source: "keyword",
      degraded: true,
      fallbackFrom: "jev",
      fallbackReason: "unavailable",
    });
  });

  it("reuses accepted decisions until their TTL expires", async () => {
    let now = 1_000;
    const decide = vi.fn(async (request: DecisionRequest) => responseFor(request));
    const classifier = createClassifier({ decide, now: () => now });

    await classifier.classify(task);
    now += DEFAULT_DECISION_CACHE_TTL_MS - 1;
    await classifier.classify(task);
    now += 2;
    await classifier.classify(task);

    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("does not cache low-confidence decisions", async () => {
    const decide = vi.fn(async (request: DecisionRequest) =>
      responseFor(request, { task_complexity: choice("moderate", 0.49) }),
    );
    const classifier = createClassifier({ decide });

    await classifier.classify(task);
    await classifier.classify(task);

    expect(decide).toHaveBeenCalledTimes(2);
  });
});
