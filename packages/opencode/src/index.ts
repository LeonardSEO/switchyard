import { createGateway, type Gateway } from "@vepando/switchyard-gateway";

/**
 * OpenCode plugin.
 *
 * OpenCode has no hook rich enough to pick a model per request, but it does
 * support custom OpenAI-compatible providers. So the plugin does the boring,
 * necessary thing: make sure a Switchyard gateway is reachable, and tell the user
 * the one snippet to add to opencode.json. Routing then happens in the gateway,
 * per request, with the same logic the Pi adapter uses.
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

export async function ensureGateway(
  port = Number(process.env.SWITCHYARD_PORT ?? DEFAULT_PORT),
  fetchFn: typeof fetch = fetch,
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
    gateway = await createGateway({ port, apiKey: process.env.OPENROUTER_API_KEY });
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

/** The config the user needs once. */
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

export const SwitchyardPlugin = async (_input: OpenCodePluginInput = {}) => {
  const handle = await ensureGateway();
  const config = providerConfig(handle.baseUrl, handle.port);

  console.log(`[switchyard] gateway ${handle.baseUrl} (${handle.started ? "started" : "already running"})`);
  console.log("[switchyard] add this to opencode.json, then pick model `switchyard/auto`:");
  console.log(JSON.stringify(config, null, 2));

  return {
    event: async ({ event }: { event: { type?: string } }) => {
      // Nothing to do per event yet: routing happens in the gateway.
      if (event?.type === "session.error") {
        console.warn("[switchyard] session error; is the gateway still up?");
      }
    },
  };
};

export default SwitchyardPlugin;
