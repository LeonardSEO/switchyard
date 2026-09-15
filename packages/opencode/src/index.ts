import { createGateway, type Gateway } from "@vepando/switchyard-gateway";
import { resolveOpenRouterApiKey } from "./credentials.js";

export { resolveOpenRouterApiKey } from "./credentials.js";

/**
 * OpenCode plugin.
 *
 * OpenCode has no hook rich enough to pick a model per request, but it does
 * support custom OpenAI-compatible providers. The plugin starts a local
 * Switchyard gateway and registers that provider automatically. Routing then
 * happens in the gateway, per request, with the same logic the Pi adapter uses.
 */

export interface OpenCodePluginInput {
  client?: unknown;
  $?: unknown;
  directory?: string;
  worktree?: string;
  project?: unknown;
}

export const DEFAULT_PORT = 8787;

export interface GatewayHandle {
  port: number;
  baseUrl: string;
  started: boolean;
  close?: () => Promise<void>;
}

export interface OpenCodeConfig {
  provider?: Record<string, unknown>;
}

interface EnsureGatewayDependencies {
  resolveApiKey?: () => Promise<string | undefined>;
  startGateway?: typeof createGateway;
}

export async function ensureGateway(
  port = Number(process.env.SWITCHYARD_PORT ?? DEFAULT_PORT),
  fetchFn: typeof fetch = fetch,
  dependencies: EnsureGatewayDependencies = {},
): Promise<GatewayHandle> {
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { port, baseUrl, started: false };
  } catch {
    // not running yet
  }

  let gateway: Gateway;
  try {
    const apiKey = await (dependencies.resolveApiKey ?? resolveOpenRouterApiKey)();
    gateway = await (dependencies.startGateway ?? createGateway)({ port, apiKey });
  } catch (err) {
    if (isAddressInUse(err)) {
      return { port, baseUrl, started: false };
    }
    throw err;
  }
  return {
    port: gateway.port,
    baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
    started: true,
    close: gateway.close,
  };
}

function isAddressInUse(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EADDRINUSE" || code === "EADDRNOTAVAIL";
}

export function providerConfig(baseUrl: string, port: number) {
  return {
    provider: {
      switchyard: {
        npm: "@ai-sdk/openai-compatible",
        name: "Switchyard",
        options: { baseURL: baseUrl.replace(/\/v1$/, "/v1") },
        models: {
          auto: { name: `Switchyard auto (routing on :${port})` },
        },
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Add Switchyard without overwriting user-supplied provider options or models. */
export function configureOpenCode(config: OpenCodeConfig, baseUrl: string, port: number): void {
  const defaults = providerConfig(baseUrl, port).provider.switchyard;
  const providers = record(config.provider);
  const existing = record(providers.switchyard);
  const existingOptions = record(existing.options);
  const existingModels = record(existing.models);

  config.provider = {
    ...providers,
    switchyard: {
      ...defaults,
      ...existing,
      options: { ...defaults.options, ...existingOptions },
      models: { ...defaults.models, ...existingModels },
    },
  };
}

export function createOpenCodePlugin(startGateway: typeof ensureGateway = ensureGateway) {
  return async (_input: OpenCodePluginInput = {}) => {
    const handle = await startGateway();

    return {
      config: async (config: OpenCodeConfig) => {
        configureOpenCode(config, handle.baseUrl, handle.port);
      },
      dispose: async () => {
        if (handle.started) await handle.close?.();
      },
    };
  };
}

export const SwitchyardPlugin = createOpenCodePlugin();

export default SwitchyardPlugin;
