import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
  extensions?: string[];
}

interface PackageManifest {
  name?: string;
  bin?: Record<string, string>;
  pi?: ExtensionManifest;
  omp?: ExtensionManifest;
}

interface MarketplaceManifest {
  name?: string;
  plugins?: Array<{ name?: string; source?: string; version?: string }>;
}

describe("coding-agent package manifests", () => {
  const packageRoot = resolve(import.meta.dirname, "..");
  const repositoryRoot = resolve(packageRoot, "../..");
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;

  it.each(["pi", "omp"] as const)("declares a loadable %s extension", (host) => {
    const entries = manifest[host]?.extensions;
    expect(entries).toEqual(["./extensions"]);
    expect(existsSync(resolve(packageRoot, entries![0], "switchyard.js"))).toBe(true);
  });

  it("publishes a resolvable OMP marketplace entry", () => {
    const marketplace = JSON.parse(
      readFileSync(resolve(repositoryRoot, ".omp-plugin/marketplace.json"), "utf8"),
    ) as MarketplaceManifest;
    const plugin = marketplace.plugins?.find((entry) => entry.name === "switchyard");

    expect(marketplace.name).toBe("switchyard");
    expect(plugin?.source).toBe("./packages/adapter-pi");
    expect(plugin?.version).toBe(manifestVersion(repositoryRoot));

    const pluginManifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, plugin!.source!, "package.json"), "utf8"),
    ) as PackageManifest;
    expect(pluginManifest.name).toBe("@vepando/switchyard");
    expect(pluginManifest.omp?.extensions).toEqual(["./extensions"]);
  });

  it("publishes an executable gateway binary", () => {
    expect(manifest.bin?.["switchyard-gateway"]).toBe("bin/switchyard-gateway.js");
    const mode = statSync(resolve(packageRoot, "bin", "switchyard-gateway.js")).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

function manifestVersion(repositoryRoot: string): string | undefined {
  const root = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { version?: string };
  return root.version;
}
