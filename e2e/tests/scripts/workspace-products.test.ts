import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveOutputs, executeSource, restoreOutputs } from "../../../.github/scripts/release/workspace-products.ts";

type Options = Parameters<typeof executeSource>[0];
type Output = ReturnType<Options["runUnit"]>;
const roots: string[] = [];
const outputs: Output[] = ([
  ["packages", ["packages/platform/dist"]], ["daemon", ["apps/daemon/dist"]],
  ["web", ["apps/web/dist", "apps/web/.next/standalone", "apps/web/.next/static"]],
  ["shell", ["apps/desktop/dist", "apps/packaged/dist"]],
] as const).map(([unit, outputPaths]) => ({ schemaVersion: 1, unit, outputPaths: [...outputPaths],
  platform: process.platform, arch: process.arch, webOutputMode: "standalone" }));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspace-products-"));
  roots.push(root);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const runUnit = vi.fn<Options["runUnit"]>((action, unit) => {
    const output = outputs.find((entry) => entry.unit === unit)!;
    if (action === "build") for (const path of output.outputPaths) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "index.js"), unit);
    }
    return output;
  });
  const pending: Options["pending"] = { schemaVersion: 1, protocol: "nexu-workload-result-v1", mode: "enforce",
    workloads: { source: { scopeEnabled: true, reusable: true, run: true, resultHit: false } } };
  return { root, scratch, runUnit, pending, workload: "source" };
}

function product(archive: string, directory: string) {
  const zip = join(directory, "product.zip");
  execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[2],'w'); z.write(sys.argv[1],'workspace.tar.gz'); z.close()", archive, zip]);
  const bytes = readFileSync(zip);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  return { type: "url", source: "https://cache.example/source.zip", data: { sha256: createHash("sha256").update(bytes).digest("hex") } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native source result consumption", () => {
  it("builds the complete cold result, then restores without invoking any source build", async () => {
    const f = fixture();
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: true });
    expect(f.runUnit.mock.calls.map(([action, unit]) => `${action}:${unit}`)).toEqual([
      "build:packages", "build:daemon", "build:web", "build:shell",
    ]);
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    const web = join(f.root, "apps/web/.next/static");
    writeFileSync(join(web, "stale.js"), "must disappear");
    f.pending.workloads.source = { scopeEnabled: true, reusable: true, run: false, resultHit: true, result: { products: { bundle } } };
    f.runUnit.mockClear();
    expect(await executeSource(f)).toMatchObject({ restored: true, produced: false });
    expect(f.runUnit.mock.calls.every(([action]) => action === "result")).toBe(true);
    expect(existsSync(join(web, "stale.js"))).toBe(false);
  });

  it("preserves executable modes and pristine maps while materializing symlinks", async () => {
    const f = fixture();
    outputs.forEach(({ unit }) => f.runUnit("build", unit));
    const directory = join(f.root, "apps/web/.next/static");
    writeFileSync(join(directory, "index.js.map"), "pristine");
    chmodSync(join(directory, "index.js"), 0o755);
    symlinkSync("index.js", join(directory, "linked.js"));
    const archive = archiveOutputs(f.root, join(f.scratch, "product"), outputs);
    const bundle = product(archive, f.scratch);
    rmSync(directory, { recursive: true });
    await restoreOutputs(f.root, f.scratch, bundle);
    expect(readFileSync(join(directory, "index.js.map"), "utf8")).toBe("pristine");
    expect(readFileSync(join(directory, "linked.js"), "utf8")).toBe("web");
    expect(statSync(join(directory, "index.js")).mode & 0o111).not.toBe(0);
  });

  it("falls back after a checksum failure without publishing over an immutable hit", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("corrupt")));
    f.pending.workloads.source = { scopeEnabled: true, reusable: true, resultHit: true, run: false,
      result: { products: { bundle: { type: "url", source: "https://cache.example/source.zip", data: { sha256: "a".repeat(64) } } } } };
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: false });
    expect(f.runUnit.mock.calls).toHaveLength(4);
    expect(existsSync(join(f.scratch, "product"))).toBe(false);
  });

  it("keeps shadow execution independent of observed hits and emits no reusable product", async () => {
    const f = fixture();
    f.pending.mode = "shadow";
    f.pending.workloads.source!.resultHit = true;
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: false });
    expect(f.runUnit.mock.calls.every(([action]) => action === "build")).toBe(true);
  });

  it("rejects broad output replacement targets before creating an archive", () => {
    const f = fixture();
    expect(() => archiveOutputs(f.root, join(f.scratch, "product"),
      outputs.map((entry, index) => index === 0 ? { ...entry, outputPaths: ["packages"] } : entry)))
      .toThrow("unsafe source output path");
    expect(existsSync(join(f.scratch, "product"))).toBe(false);
  });
});
