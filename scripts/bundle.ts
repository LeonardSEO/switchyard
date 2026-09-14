import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm" as const,
  platform: "node" as const,
  target: "node20",
  sourcemap: true,
  packages: "bundle" as const,
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["packages/adapter-pi/src/index.ts"],
    outfile: "packages/adapter-pi/dist/pi.js",
  }),
  build({
    ...shared,
    entryPoints: ["packages/opencode/src/plugin-entry.ts"],
    outfile: "packages/adapter-pi/dist/opencode.js",
  }),
  build({
    ...shared,
    entryPoints: ["packages/gateway/src/index.ts"],
    outfile: "packages/adapter-pi/dist/gateway.js",
  }),
  build({
    ...shared,
    entryPoints: ["packages/gateway/src/cli.ts"],
    outfile: "packages/adapter-pi/dist/gateway-cli.js",
  }),
]);
