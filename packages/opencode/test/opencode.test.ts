import { describe, expect, it, vi } from "vitest";
import { configureOpenCode, createOpenCodePlugin, ensureGateway, providerConfig, resolveOpenRouterApiKey } from "../src/index.js";

describe("OpenCode plugin", () => {
  it("builds an OpenAI-compatible Switchyard provider", () => {
    expect(providerConfig("http://127.0.0.1:9123/v1", 9123)).toEqual({
      provider: {
        switchyard: {
          npm: "@ai-sdk/openai-compatible",
          name: "Switchyard",
          options: { baseURL: "http://127.0.0.1:9123/v1" },
          models: { auto: { name: "Switchyard auto (routing on :9123)" } },
        },
      },
    });
  });

  it("registers itself while preserving custom providers and overrides", () => {
    const config = {
      provider: {
        existing: { name: "Existing" },
        switchyard: {
          options: { baseURL: "http://localhost:9999/v1", apiKey: "custom" },
          models: { custom: { name: "Custom" } },
        },
      },
    };

    configureOpenCode(config, "http://127.0.0.1:8787/v1", 8787);

    expect(config.provider.existing).toEqual({ name: "Existing" });
    expect(config.provider.switchyard).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      name: "Switchyard",
      options: { baseURL: "http://localhost:9999/v1", apiKey: "custom" },
      models: {
        auto: { name: "Switchyard auto (routing on :8787)" },
        custom: { name: "Custom" },
      },
    });
  });

  it("injects config and closes only the gateway it started", async () => {
    const close = vi.fn(async () => undefined);
    const plugin = createOpenCodePlugin(async () => ({
      port: 8787,
      baseUrl: "http://127.0.0.1:8787/v1",
      started: true,
      close,
    }));
    const hooks = await plugin();
    const config = {};

    await hooks.config(config);
    await hooks.dispose();

    expect(config).toMatchObject({ provider: { switchyard: { models: { auto: {} } } } });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not close a gateway owned by another process", async () => {
    const close = vi.fn(async () => undefined);
    const plugin = createOpenCodePlugin(async () => ({
      port: 8787,
      baseUrl: "http://127.0.0.1:8787/v1",
      started: false,
      close,
    }));
    const hooks = await plugin();

    await hooks.dispose();

    expect(close).not.toHaveBeenCalled();
  });

  it("prefers an explicit OpenRouter environment credential", async () => {
    const readTextFile = vi.fn(async () => JSON.stringify({
      openrouter: { type: "api", key: "saved-key" },
    }));

    await expect(resolveOpenRouterApiKey({
      env: { OPENROUTER_API_KEY: " explicit-key " },
      readTextFile,
    })).resolves.toBe("explicit-key");
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("reuses the OpenRouter API credential saved by OpenCode", async () => {
    const readTextFile = vi.fn(async () => JSON.stringify({
      openrouter: { type: "api", key: " saved-key " },
    }));

    await expect(resolveOpenRouterApiKey({
      env: { XDG_DATA_HOME: "/tmp/opencode-data" },
      readTextFile,
    })).resolves.toBe("saved-key");
    expect(readTextFile).toHaveBeenCalledWith("/tmp/opencode-data/opencode/auth.json");
  });

  it("ignores missing, malformed, and unsupported OpenCode credentials", async () => {
    await expect(resolveOpenRouterApiKey({
      env: {},
      readTextFile: async () => "not-json",
    })).resolves.toBeUndefined();
    await expect(resolveOpenRouterApiKey({
      env: {},
      readTextFile: async () => JSON.stringify({ openrouter: { type: "oauth", key: "wrong-type" } }),
    })).resolves.toBeUndefined();
  });

  it("passes the resolved OpenCode credential to a newly started gateway", async () => {
    const close = vi.fn(async () => undefined);
    const startGateway = vi.fn(async () => ({ port: 8787, close, handle: vi.fn() }));

    const handle = await ensureGateway(
      8787,
      vi.fn(async () => { throw new Error("not running"); }) as unknown as typeof fetch,
      {
        resolveApiKey: async () => "saved-key",
        startGateway,
      },
    );

    expect(startGateway).toHaveBeenCalledWith({ port: 8787, apiKey: "saved-key" });
    expect(handle.started).toBe(true);
    await handle.close?.();
  });
});
