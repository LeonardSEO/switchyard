import { describe, expect, it, vi } from "vitest";
import { configureOpenCode, createOpenCodePlugin, providerConfig } from "../src/index.js";

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
});
