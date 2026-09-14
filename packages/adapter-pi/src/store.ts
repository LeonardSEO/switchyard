import type { Classification } from "@vepando/switchyard-core";

/**
 * Small JSON stores under ~/.switchyard. Classification is on the critical path
 * of every turn, so its cache and its latency measurements must survive process
 * restarts; otherwise we pay the same two seconds again tomorrow.
 */

const MAX_CACHE_ENTRIES = 2_000;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), "utf8");
  } catch {
    /* never break a turn for bookkeeping */
  }
}

export const paths = (home = process.env.HOME ?? ".") => ({
  cache: `${home}/.switchyard/classifier-cache.json`,
  latency: `${home}/.switchyard/classifier-latency.json`,
  failures: `${home}/.switchyard/classifier-failures.json`,
});

/**
 * Models that failed recently (404, no endpoints, provider down). Skipped for a
 * day so a bad catalog entry cannot keep costing a round trip every turn.
 */
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadFailures(
  path = paths().failures,
  now = Date.now(),
): Promise<Record<string, number>> {
  const all = await readJson<Record<string, number>>(path, {});
  return Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < FAILURE_TTL_MS));
}

export async function recordFailure(
  modelId: string,
  path = paths().failures,
): Promise<Record<string, number>> {
  const all = await readJson<Record<string, number>>(path, {});
  all[modelId] = Date.now();
  await writeJson(path, all);
  return all;
}

/** Classification cache keyed by (prompt version, kind, normalised objective). */
export async function loadCache(path = paths().cache): Promise<Record<string, Classification>> {
  return readJson<Record<string, Classification>>(path, {});
}

export async function saveCache(
  cache: Record<string, Classification>,
  path = paths().cache,
): Promise<void> {
  const entries = Object.entries(cache).slice(-MAX_CACHE_ENTRIES);
  await writeJson(path, Object.fromEntries(entries));
}

/** Remove saved task classifications so matching tasks are classified again. */
export async function clearClassificationCache(path = paths().cache): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { force: true });
}

/**
 * Latency per classifier model, as an exponential moving average. Selection
 * uses it so the router stops choosing a model that is cheap but slow.
 */
export async function loadLatencies(path = paths().latency): Promise<Record<string, number>> {
  return readJson<Record<string, number>>(path, {});
}

export async function recordLatency(
  modelId: string,
  latencyMs: number,
  path = paths().latency,
): Promise<Record<string, number>> {
  const all = await loadLatencies(path);
  const previous = all[modelId];
  all[modelId] = previous === undefined ? latencyMs : previous * 0.7 + latencyMs * 0.3;
  await writeJson(path, all);
  return all;
}
