import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
  extensions?: string[];
}

interface PackageManifest {
  pi?: ExtensionManifest;
  omp?: ExtensionManifest;
}

describe("coding-agent package manifests", () => {
  const packageRoot = resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;

  it.each(["pi", "omp"] as const)("declares a loadable %s extension", (host) => {
    const entries = manifest[host]?.extensions;
    expect(entries).toEqual(["./extensions"]);
    expect(existsSync(resolve(packageRoot, entries![0], "switchyard.js"))).toBe(true);
  });
});
