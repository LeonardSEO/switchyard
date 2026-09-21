import { describe, expect, it, vi } from "vitest";
import type {
  DecisionChoiceAnswer,
  DecisionRequest,
} from "@vepando/switchyard-core";
import {
  createOpenRouterDecision,
  OPENROUTER_JEV_LATEST,
} from "../src/decisions.js";

function choice(value: string, confidence: number): DecisionChoiceAnswer {
  return {
    type: "choice",
    choice: value,
    probabilities: { review: confidence, "code-change": 1 - confidence },
    confidence,
  };
}

function oneQuestionRequest(): DecisionRequest {
  return {
    model: OPENROUTER_JEV_LATEST,
    state: { objective: "Review the parser change" },
    questions: {
      task_kind: {
        type: "choice",
        instructions: "Classify the task kind.",
        criteria: { review: "Assess code.", "code-change": "Modify code." },
      },
    },
  };
}

function successBody() {
  return {
    model: "typesafe/jev-1.13-20260917",
    answers: { task_kind: choice("review", 0.94) },
    usage: { cost: 0.00001, input_tokens: 200, output_tokens: 20 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouter Decisions transport", () => {
  it("posts the moving Jev alias to OpenRouter Decisions", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(successBody()),
    );
    const decide = createOpenRouterDecision({ apiKey: "test-key", fetchFn });

    const result = await decide(oneQuestionRequest());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/alpha/decisions",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).model).toBe("~typesafe/jev-latest");
    expect(result).toMatchObject({
      model: "typesafe/jev-1.13-20260917",
      costUsd: 0.00001,
    });
  });

  it("sends bearer authentication and protected attribution headers", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(successBody()),
    );
    await createOpenRouterDecision({
      apiKey: "secret-test-key",
      appUrl: "https://example.test/switchyard",
      appTitle: "Switchyard Test",
      headers: {
        "content-type": "text/plain",
        "HTTP-Referer": "https://attacker.test",
        "X-Title": "Wrong",
        "X-Custom": "kept",
      },
      fetchFn,
    })(oneQuestionRequest());

    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: "Bearer secret-test-key",
      "content-type": "application/json",
      "HTTP-Referer": "https://example.test/switchyard",
      "X-Title": "Switchyard Test",
      "X-Custom": "kept",
    });
  });

  it("uses asynchronously resolved credentials and base URL", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(successBody()),
    );
    const resolveAuth = vi.fn(async () => ({
      apiKey: "resolved-key",
      baseUrl: "https://proxy.example.test/api/v1/",
      headers: { "X-Registry": "pi" },
    }));

    await createOpenRouterDecision({
      apiKey: "static-key",
      resolveAuth,
      fetchFn,
    })(oneQuestionRequest());

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://proxy.example.test/api/alpha/decisions",
    );
    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer resolved-key");
    expect(headers["X-Registry"]).toBe("pi");
  });

  it("uses an explicit Decisions endpoint unchanged", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(successBody()),
    );
    await createOpenRouterDecision({
      apiKey: "test-key",
      decisionsBaseUrl: "https://decisions.example.test/custom",
      fetchFn,
    })(oneQuestionRequest());

    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://decisions.example.test/custom");
  });

  it("derives the alpha endpoint from a standard API v1 base URL", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(successBody()),
    );
    await createOpenRouterDecision({
      apiKey: "test-key",
      baseUrl: "https://openrouter-proxy.test/api/v1",
      fetchFn,
    })(oneQuestionRequest());

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://openrouter-proxy.test/api/alpha/decisions",
    );
  });

  it("does not guess a Decisions path for an unrelated custom base URL", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(successBody()),
    );
    await createOpenRouterDecision({
      apiKey: "test-key",
      baseUrl: "https://completion-proxy.test/custom",
      fetchFn,
    })(oneQuestionRequest());

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
  });

  it("aborts a request that exceeds its timeout", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const decide = createOpenRouterDecision({ apiKey: "test-key", fetchFn, timeoutMs: 1 });

    await expect(decide(oneQuestionRequest())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects missing credentials before fetching", async () => {
    const fetchFn = vi.fn();
    const decide = createOpenRouterDecision({ fetchFn });

    await expect(decide(oneQuestionRequest())).rejects.toThrow(
      "OpenRouter Decisions credential is unavailable",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects non-success HTTP responses without exposing their body", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ secret: "do not expose" }, 429),
    );
    const decide = createOpenRouterDecision({ apiKey: "test-key", fetchFn });

    await expect(decide(oneQuestionRequest())).rejects.toThrow(
      "OpenRouter Decisions request failed with status 429",
    );
  });

  it("rejects non-JSON and malformed successful responses", async () => {
    const nonJson = createOpenRouterDecision({
      apiKey: "test-key",
      fetchFn: vi.fn(async () => new Response("not json", { status: 200 })),
    });
    const malformed = createOpenRouterDecision({
      apiKey: "test-key",
      fetchFn: vi.fn(async () => jsonResponse({ model: "typesafe/jev-1.13", answers: [] })),
    });

    await expect(nonJson(oneQuestionRequest())).rejects.toThrow(
      "OpenRouter Decisions returned invalid JSON",
    );
    await expect(malformed(oneQuestionRequest())).rejects.toThrow(
      "OpenRouter Decisions returned a malformed response",
    );
  });
});
