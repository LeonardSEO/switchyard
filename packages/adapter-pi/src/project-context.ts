import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import type { PiContextFileLike } from "./pi.js";

const MAX_PROFILE_CHARS = 16_000;
const MAX_FILE_CHARS = 6_000;
const MAX_TREE_ENTRIES = 180;
const MAX_TREE_DEPTH = 2;
const IGNORED = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

/**
 * Build a cheap, deterministic repository profile. Pi's structured context
 * files win; filesystem discovery keeps this useful on older Pi versions.
 */
export async function buildProjectContext(
  cwd: string,
  loadedContextFiles: PiContextFileLike[] = [],
): Promise<string> {
  const workingDirectory = resolve(cwd);
  const root = await findProjectRoot(workingDirectory);
  const sections = [`Project: ${basename(root)}`];

  const manifest = await readManifestSummary(root);
  if (manifest) sections.push(`PROJECT METADATA\n${manifest}`);

  const tree = await readProjectTree(root);
  if (tree) sections.push(`PROJECT STRUCTURE (depth ${MAX_TREE_DEPTH})\n${tree}`);

  const contextFiles = await readContextFiles(root, workingDirectory, loadedContextFiles);
  if (contextFiles) sections.push(`PROJECT INSTRUCTIONS AND ARCHITECTURE\n${contextFiles}`);

  return truncate(sections.join("\n\n"), MAX_PROFILE_CHARS);
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

async function readManifestSummary(root: string): Promise<string | undefined> {
  const packagePath = join(root, "package.json");
  try {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    const names = (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).slice(0, 120)
        : undefined;
    return JSON.stringify(
      {
        manifest: "package.json",
        name: parsed.name,
        type: parsed.type,
        workspaces: parsed.workspaces,
        scripts: names(parsed.scripts),
        dependencies: names(parsed.dependencies),
        devDependencies: names(parsed.devDependencies),
      },
      null,
      2,
    );
  } catch {
    // A missing or malformed package.json simply means this is not an npm project.
  }

  for (const name of ["pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"]) {
    try {
      const content = await readFile(join(root, name), "utf8");
      const metadata = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(
          (line) =>
            /^\[[^\]]+\]$/.test(line) ||
            /^(name|module|group|artifactId|rootProject\.name)\s*[=:]/.test(line),
        )
        .slice(0, 120)
        .join("\n");
      return `${name}${metadata ? `\n${truncate(metadata, MAX_FILE_CHARS)}` : ""}`;
    } catch {
      // Try the next common manifest.
    }
  }
  return undefined;
}

async function readProjectTree(root: string): Promise<string> {
  const lines: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0 && lines.length < MAX_TREE_ENTRIES) {
    const item = queue.shift()!;
    let entries;
    try {
      entries = await readdir(item.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const path = join(item.directory, entry.name);
      const display = relative(root, path);
      lines.push(entry.isDirectory() ? `${display}/` : display);
      if (lines.length >= MAX_TREE_ENTRIES) break;
      if (entry.isDirectory() && item.depth < MAX_TREE_DEPTH) {
        queue.push({ directory: path, depth: item.depth + 1 });
      }
    }
  }
  if (queue.length > 0 || lines.length >= MAX_TREE_ENTRIES) lines.push("[structure truncated]");
  return lines.join("\n");
}

async function readContextFiles(
  root: string,
  cwd: string,
  loaded: PiContextFileLike[],
): Promise<string | undefined> {
  const selected = loaded.flatMap((file) => {
    if (typeof file.path !== "string" || typeof file.content !== "string") return [];
    const path = resolve(cwd, file.path);
    return isInside(root, path) ? [{ path, content: file.content }] : [];
  });
  if (selected.length > 0) {
    return selected
      .map((file) => `# ${relative(root, file.path)}\n${truncate(file.content, MAX_FILE_CHARS)}`)
      .join("\n\n");
  }

  const parts: string[] = [];
  for (const directory of directoriesBetween(root, cwd)) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(directory, name);
      try {
        parts.push(`# ${relative(root, path)}\n${truncate(await readFile(path, "utf8"), MAX_FILE_CHARS)}`);
      } catch {
        // Context files are optional.
      }
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function directoriesBetween(root: string, cwd: string): string[] {
  if (!isInside(root, cwd)) return [root];
  const parts = relative(root, cwd).split(/[/\\]/).filter(Boolean);
  const directories = [root];
  for (const part of parts) directories.push(join(directories.at(-1)!, part));
  return directories;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = "\n[truncated]";
  return `${value.slice(0, max - marker.length)}${marker}`;
}
