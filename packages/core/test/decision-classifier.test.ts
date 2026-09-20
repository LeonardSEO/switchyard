import { describe, expect, it } from "vitest";
import {
  DecisionClassifier,
  type DecisionChoiceAnswer,
  type DecisionRequest,
} from "../src/decision-classifier.js";
import type { Classifier } from "../src/classifier.js";

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
});
