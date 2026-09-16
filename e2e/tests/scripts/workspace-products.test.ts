import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveExecutable, archiveOutputs, executeSource, restoreOutputs } from "../../../.github/scripts/release/workspace-products.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), rmSync: vi.fn(fs.rmSync) };
});

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
  const request: Options["request"] = { units: outputs.map(({ unit }) => unit), operation: "build", retain: true };
  return { root, scratch, runUnit, request };
}

function product(archive: string, directory: string) {
  const zip = join(directory, "product.zip");
  execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[2],'w'); z.write(sys.argv[1],'workspace.tar.gz'); z.close()", archive, zip]);
  const bytes = readFileSync(zip);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  return { type: "url", source: "https://cache.example/source.zip", data: { sha256: createHash("sha256").update(bytes).digest("hex") } };
}

function hitFixture() {
  const f = fixture();
  Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: "https://cache.example/source.zip", sha256: "a".repeat(64) } });
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(renameSync).mockReset();
  vi.mocked(rmSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native source result consumption", () => {
  it.each(["packages", "daemon", "web", "shell"] as const)("builds and restores only the selected %s unit", async (unit) => {
    const f = fixture();
    f.request.units = [unit];
    const selected = f;
    expect(await executeSource(selected)).toMatchObject({ produced: true, restored: false });
    expect(f.runUnit.mock.calls).toEqual([["build", unit]]);
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: bundle.source, sha256: bundle.data.sha256 } });
    f.runUnit.mockClear();
    expect(await executeSource(selected)).toMatchObject({ produced: false, restored: true });
    expect(f.runUnit.mock.calls).toEqual([["result", unit]]);
    for (const output of outputs.filter((entry) => entry.unit !== unit)) {
      for (const path of output.outputPaths) expect(existsSync(join(f.root, path))).toBe(false);
    }
  });

  it("rejects another unit's bundle without building or replacing outputs", async () => {
    const f = fixture();
    await executeSource({ ...f, request: { ...f.request, units: ["daemon"] } });
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: bundle.source, sha256: bundle.data.sha256 } });
    f.runUnit.mockClear();
    await expect(executeSource({ ...f, request: { ...f.request, units: ["web"] } })).rejects.toThrow("incompatible source output set");
    expect(f.runUnit).not.toHaveBeenCalled();
    expect(readFileSync(join(f.root, "apps/daemon/dist/index.js"), "utf8")).toBe("daemon");
    expect(existsSync(join(f.root, "apps/web/dist"))).toBe(false);
  });

  it("selects Windows system bsdtar independently of Git Bash PATH", () => {
    expect(archiveExecutable("win32", "C:\\Windows")).toBe("C:\\Windows\\System32\\tar.exe");
    expect(archiveExecutable("darwin")).toBe("tar");
    expect(() => archiveExecutable("win32", "relative")).toThrow("SystemRoot");
  });
  it("builds the complete cold result, then restores without invoking any source build", async () => {
    const f = fixture();
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: true });
    expect(f.runUnit.mock.calls.map(([action, unit]) => `${action}:${unit}`)).toEqual([
      "build:packages", "build:daemon", "build:web", "build:shell",
    ]);
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    const web = join(f.root, "apps/web/.next/static");
    writeFileSync(join(web, "stale.js"), "must disappear");
    Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: bundle.source, sha256: bundle.data.sha256 } });
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
    Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: "https://cache.example/source.zip", sha256: "a".repeat(64) } });
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: false, fallback: { reason: "checksum-mismatch", attempts: 1 } });
    expect(f.runUnit.mock.calls).toHaveLength(4);
    expect(existsSync(join(f.scratch, "product"))).toBe(false);
  });

  it("accounts for downloaded bytes and a successful timeout fallback", async () => {
    const f = hitFixture();
    const report = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      pull(controller) { controller.error(new DOMException("timeout", "TimeoutError")); },
    }))));
    const result = await executeSource({ ...f, report });
    expect(result).toMatchObject({ bytes: 3, restored: false, produced: false,
      fallback: { reason: "download-timeout", attempts: 1, buildDurationMs: expect.any(Number) } });
    expect(report).toHaveBeenCalledTimes(2);
    expect(f.runUnit).toHaveBeenCalledTimes(4);
  });

  it.each([404, 410])("rebuilds once after HTTP %s and cleans download scratch first", async (status) => {
    const f = hitFixture();
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const build = f.runUnit.getMockImplementation()!;
    f.runUnit.mockImplementation((action, unit) => {
      expect(readdirSync(f.scratch)).toEqual([]);
      return build(action, unit);
    });
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: false, fallback: { reason: "object-missing", attempts: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(f.runUnit).toHaveBeenCalledTimes(4);
  });

  it("rebuilds once after a download timeout, without retrying a failed build", async () => {
    const f = hitFixture();
    const report = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    f.runUnit.mockImplementation(() => { throw new Error("build failed"); });
    await expect(executeSource({ ...f, report })).rejects.toThrow("build failed");
    expect(f.runUnit).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
      fallback: expect.objectContaining({ reason: "download-timeout", buildDurationMs: expect.any(Number) }),
    }));
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  it.each([new DOMException("cancelled", "AbortError"), new Error("unknown fetch failure")])(
    "does not turn cancellation or unknown transport errors into builds: %s", async (error) => {
      const f = hitFixture();
      vi.stubGlobal("fetch", vi.fn(async () => { throw error; }));
      await expect(executeSource(f)).rejects.toThrow(error.message);
      expect(f.runUnit).not.toHaveBeenCalled();
      expect(readdirSync(f.scratch)).toEqual([]);
    });

  it.each([401, 403, 500])("fails closed on non-enumerated HTTP %s", async (status) => {
    const f = hitFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    await expect(executeSource(f)).rejects.toThrow(`HTTP ${status}`);
    expect(f.runUnit).not.toHaveBeenCalled();
  });

  it("does not rebuild when the frozen product reference is absent", async () => {
    const f = hitFixture();
    delete f.request.artifact;
    await expect(executeSource(f)).rejects.toThrow("missing source product");
    expect(f.runUnit).not.toHaveBeenCalled();
  });

  it("does not rebuild when a verified restored result fails its consumer contract", async () => {
    const f = fixture();
    await executeSource(f);
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: bundle.source, sha256: bundle.data.sha256 } });
    f.runUnit.mockClear().mockImplementation(() => { throw new Error("result contract mismatch"); });
    await expect(executeSource(f)).rejects.toThrow("result contract mismatch");
    expect(f.runUnit.mock.calls).toEqual([["result", "packages"]]);
  });

  it("keeps shadow execution independent of observed hits and emits no reusable product", async () => {
    const f = fixture();
    f.request.retain = false;
    expect(await executeSource(f)).toMatchObject({ restored: false, produced: false });
    expect(f.runUnit.mock.calls.every(([action]) => action === "build")).toBe(true);
  });

  it("restores previous output directories when replacement fails midway", async () => {
    const f = fixture();
    await executeSource(f);
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    for (const output of outputs) for (const path of output.outputPaths) {
      writeFileSync(join(f.root, path, "index.js"), "previous");
    }
    const originalRename = vi.mocked(renameSync).getMockImplementation()!;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).includes("/tree/apps/daemon/dist")) throw new Error("replacement failed");
      originalRename(from, to);
    });
    await expect(restoreOutputs(f.root, f.scratch, bundle)).rejects.toThrow("replacement failed");
    for (const output of outputs) for (const path of output.outputPaths) {
      expect(readFileSync(join(f.root, path, "index.js"), "utf8")).toBe("previous");
    }
  });

  it("does not rebuild when temporary restoration cleanup fails", async () => {
    const f = hitFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("corrupt")));
    const originalRemove = vi.mocked(rmSync).getMockImplementation()!;
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (String(path).includes("/restore-")) throw new Error("cleanup failed");
      originalRemove(path, options);
    });
    await expect(executeSource(f)).rejects.toThrow("cleanup failed");
    expect(f.runUnit).not.toHaveBeenCalled();
  });

  it("retains the previous leaves when rollback itself fails and never invokes a consumer", async () => {
    const f = fixture();
    await executeSource(f);
    const bundle = product(join(f.scratch, "product/workspace.tar.gz"), f.scratch);
    writeFileSync(join(f.root, "packages/platform/dist/index.js"), "previous");
    const originalRename = vi.mocked(renameSync).getMockImplementation()!;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(from).includes("/tree/apps/daemon/dist") || String(from).endsWith("/previous/0")) {
        throw new Error("replacement or rollback failed");
      }
      originalRename(from, to);
    });
    Object.assign(f.request, { operation: "restore", retain: false, artifact: { url: bundle.source, sha256: bundle.data.sha256 } });
    f.runUnit.mockClear();
    await expect(executeSource(f)).rejects.toThrow("source rollback failed; recovery retained");
    expect(f.runUnit).not.toHaveBeenCalled();
    const recovery = readdirSync(f.scratch).find((path) => path.startsWith("restore-"))!;
    expect(readFileSync(join(f.scratch, recovery, "previous/0/index.js"), "utf8")).toBe("previous");
  });

  it("rejects broad output replacement targets before creating an archive", () => {
    const f = fixture();
    expect(() => archiveOutputs(f.root, join(f.scratch, "product"),
      outputs.map((entry, index) => index === 0 ? { ...entry, outputPaths: ["packages"] } : entry)))
      .toThrow("unsafe source output path");
    expect(existsSync(join(f.scratch, "product"))).toBe(false);
  });
});
