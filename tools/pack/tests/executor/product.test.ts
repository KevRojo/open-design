import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listArchive, readTarEntry } from "@open-design/download";
import {
  exportReleaseExecutorProduct,
  releaseExecutorManifest,
} from "@/executor/product.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "release-executor-product-"));
  roots.push(root);
  return root;
}

describe("release executor product", () => {
  it("exports one reproducible platform contract without command links", async () => {
    const root = await fixture();
    const archive = join(root, "product", "workspace.tar.gz");
    const runDeploy = async (_packageName: string, destination: string) => {
      await mkdir(join(destination, "dist"), { recursive: true });
      await mkdir(join(destination, "node_modules", ".bin"), { recursive: true });
      await writeFile(join(destination, "dist", "index.mjs"), "export {};\n");
      await symlink(join(destination, "dist", "index.mjs"), join(destination, "node_modules", ".bin", "tool"));
    };
    const copyRelease = async (destination: string) => {
      await mkdir(join(destination, "dist"), { recursive: true });
      await writeFile(join(destination, "dist", "index.mjs"), "export {};\n");
    };

    const result = await exportReleaseExecutorProduct({ copyRelease, output: archive, runDeploy });
    expect(result.manifest).toEqual(releaseExecutorManifest());
    expect(result.bytes).toBeGreaterThan(0);
    expect(listArchive(archive, "tar.gz")).toContain("manifest.json");
    expect(listArchive(archive, "tar.gz").some((entry) => entry.includes("/.bin/"))).toBe(false);
    expect(JSON.parse(readTarEntry(archive, "manifest.json"))).toEqual(result.manifest);
  });

  it("rejects a deploy tree with links outside command shims", async () => {
    const root = await fixture();
    const runDeploy = async (_packageName: string, destination: string) => {
      await mkdir(join(destination, "dist"), { recursive: true });
      await writeFile(join(destination, "dist", "index.mjs"), "export {};\n");
      await symlink(join(destination, "dist", "index.mjs"), join(destination, "unsafe-link"));
    };
    const copyRelease = async (destination: string) => {
      await mkdir(join(destination, "dist"), { recursive: true });
      await writeFile(join(destination, "dist", "index.mjs"), "export {};\n");
    };
    await expect(exportReleaseExecutorProduct({
      copyRelease,
      output: join(root, "workspace.tar.gz"),
      runDeploy,
    })).rejects.toThrow("contains a symbolic link");
  });

  it("requires the current platform execution class", async () => {
    const root = await fixture();
    await expect(exportReleaseExecutorProduct({
      arch: "impossible" as NodeJS.Architecture,
      output: join(root, "workspace.tar.gz"),
      runDeploy: async () => {},
    })).rejects.toThrow("differs from host");
  });
});
