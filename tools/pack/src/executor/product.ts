import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createTarArchive } from "@open-design/download";

import { execFileAsync } from "../mac/commands.js";
import { WORKSPACE_ROOT } from "../workspace-root.js";

export const RELEASE_EXECUTOR_PRODUCT_SCHEMA = 1;

export type ReleaseExecutorProductManifest = {
  arch: NodeJS.Architecture;
  entries: {
    pack: "pack/dist/index.mjs";
    release: "release/dist/index.mjs";
  };
  platform: NodeJS.Platform;
  protocol: "open-design-release-executor-v1";
  schemaVersion: typeof RELEASE_EXECUTOR_PRODUCT_SCHEMA;
};

export type ReleaseExecutorExportOptions = {
  arch?: NodeJS.Architecture;
  output: string;
  platform?: NodeJS.Platform;
  copyRelease?: (destination: string) => Promise<void>;
  runDeploy?: (packageName: string, destination: string, includeOptional: boolean) => Promise<void>;
};

async function removeCommandLinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name === ".bin") {
      await rm(path, { force: true, recursive: true });
    } else if (entry.isDirectory()) {
      await removeCommandLinks(path);
    }
  }
}

async function assertPortableTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`release executor contains a symbolic link: ${path}`);
    if (metadata.isDirectory()) await assertPortableTree(path);
    else if (!metadata.isFile()) throw new Error(`release executor contains a special file: ${path}`);
  }
}

async function defaultDeploy(packageName: string, destination: string, includeOptional: boolean): Promise<void> {
  await execFileAsync("pnpm", [
    "--filter",
    packageName,
    "--prod",
    ...(includeOptional ? [] : ["--no-optional"]),
    "deploy",
    "--legacy",
    "--ignore-scripts",
    "--config.node-linker=hoisted",
    destination,
  ]);
}

async function defaultCopyRelease(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(join(WORKSPACE_ROOT, "tools/release/dist"), join(destination, "dist"), { recursive: true });
  await cp(join(WORKSPACE_ROOT, "tools/release/resources"), join(destination, "resources"), { recursive: true });
}

export function releaseExecutorManifest(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ReleaseExecutorProductManifest {
  return {
    arch,
    entries: {
      pack: "pack/dist/index.mjs",
      release: "release/dist/index.mjs",
    },
    platform,
    protocol: "open-design-release-executor-v1",
    schemaVersion: RELEASE_EXECUTOR_PRODUCT_SCHEMA,
  };
}

export async function exportReleaseExecutorProduct(options: ReleaseExecutorExportOptions): Promise<{
  archive: string;
  bytes: number;
  manifest: ReleaseExecutorProductManifest;
}> {
  const output = resolve(options.output);
  const manifest = releaseExecutorManifest(options.platform, options.arch);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`release executor target ${manifest.platform}/${manifest.arch} differs from host ${process.platform}/${process.arch}`);
  }
  if ((await stat(output).catch(() => null)) != null) throw new Error(`release executor output already exists: ${output}`);

  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "open-design-release-executor-"));
  const stage = join(temporary, "executor");
  const runDeploy = options.runDeploy ?? defaultDeploy;
  const copyRelease = options.copyRelease ?? defaultCopyRelease;
  try {
    await mkdir(stage, { recursive: true });
    await runDeploy("@open-design/tools-pack", join(stage, "pack"), true);
    await copyRelease(join(stage, "release"));
    await removeCommandLinks(stage);
    await assertPortableTree(stage);
    for (const entry of Object.values(manifest.entries)) {
      if (!(await stat(join(stage, entry)).catch(() => null))?.isFile()) {
        throw new Error(`release executor entry is missing: ${entry}`);
      }
    }
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    createTarArchive(output, [{ directory: stage, entries: ["manifest.json", "pack", "release"] }], {
      reproducible: true,
    });
    return { archive: output, bytes: (await stat(output)).size, manifest };
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

export async function readReleaseExecutorManifest(path: string): Promise<ReleaseExecutorProductManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReleaseExecutorProductManifest>;
  if (
    value.schemaVersion !== RELEASE_EXECUTOR_PRODUCT_SCHEMA
    || value.protocol !== "open-design-release-executor-v1"
    || typeof value.platform !== "string"
    || typeof value.arch !== "string"
    || value.entries?.pack !== "pack/dist/index.mjs"
    || value.entries?.release !== "release/dist/index.mjs"
  ) {
    throw new Error("invalid release executor manifest");
  }
  return value as ReleaseExecutorProductManifest;
}
