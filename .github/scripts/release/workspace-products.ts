// Native executor for a frozen Plan decision. No Git inputs, key calculation,
// cache writes, or release version policy. tools-pack receives ordinary files.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const units = ["packages", "daemon", "web", "shell"] as const;
type Unit = typeof units[number];
type Output = { schemaVersion: number; unit: Unit; platform: string; arch: string; webOutputMode: string; outputPaths: string[] };
type Product = { type: string; source: string; data: { sha256: string } };
type Decision = { scopeEnabled: boolean; reusable: boolean; resultHit: boolean; run: boolean;
  result?: { products: Record<string, Product> } };
type Pending = { schemaVersion: number; protocol: string; mode: string; workloads: Record<string, Decision> };

function command(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
  return result.stdout;
}

function pathsOf(outputs: Output[]): string[] {
  if (!Array.isArray(outputs) || outputs.length !== units.length) throw new Error("incomplete source output set");
  const paths: string[] = [];
  for (const [index, output] of outputs.entries()) {
    if (output.schemaVersion !== 1 || output.unit !== units[index] || output.platform !== process.platform
      || output.arch !== process.arch || output.webOutputMode !== "standalone" || !Array.isArray(output.outputPaths)
      || output.outputPaths.length === 0) throw new Error("incompatible source output set");
    for (const path of output.outputPaths) {
      // Generated leaf directories only. Never permit a repository/package root
      // as a deletion or replacement target, even from a checksum-verified file.
      if (!/^(packages\/[a-z0-9-]+\/dist|apps\/(daemon|web|desktop|packaged)\/dist|apps\/web\/\.next\/(standalone|static))$/.test(path)) {
        throw new Error(`unsafe source output path: ${path}`);
      }
      paths.push(path);
    }
  }
  if (new Set(paths).size !== paths.length) throw new Error("duplicate source output path");
  return paths;
}

function assertMaterializedTree(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) assertMaterializedTree(join(directory, entry.name));
    else if (!entry.isFile()) throw new Error("source product contains an unmaterialized link or special file");
  }
}

export function archiveOutputs(root: string, directory: string, outputs: Output[]): string {
  const paths = pathsOf(outputs);
  mkdirSync(directory, { recursive: true });
  const archive = resolve(directory, "workspace.tar.gz");
  writeFileSync(join(directory, "outputs.json"), JSON.stringify(outputs));
  // Dereference pnpm links/junctions, matching tools-pack's existing cache
  // materialization. Tar preserves executable modes; the outer artifact ZIP
  // contains one opaque file and cannot flatten .next's file semantics.
  command("tar", ["-czhf", archive, "-C", root, ...paths, "-C", resolve(directory), "outputs.json"], root);
  return archive;
}

async function download(product: Product, path: string): Promise<number> {
  const url = new URL(product.source);
  if (product.type !== "url" || url.protocol !== "https:" || url.username || url.password
    || url.search || url.hash || !/^[a-f0-9]{64}$/.test(product.data?.sha256 ?? "")) throw new Error("invalid source product reference");
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`source product HTTP ${response.status}`);
  const hash = createHash("sha256");
  const output = await open(path, "wx");
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 ** 3) throw new Error("source product exceeds 2 GiB");
      hash.update(chunk.value);
      await output.writeFile(chunk.value);
    }
  } finally {
    await reader.cancel();
    await output.close();
  }
  if (hash.digest("hex") !== product.data.sha256) throw new Error("source product checksum mismatch");
  return bytes;
}

export async function restoreOutputs(root: string, scratch: string, product: Product): Promise<number> {
  const directory = mkdtempSync(join(scratch, "restore-"));
  try {
    const zip = join(directory, "product.zip");
    const bytes = await download(product, zip);
    // Target systems ship bsdtar with ZIP support; Linux contract tests use
    // unzip. This is byte transport only, never the Python planning control.
    const members = (process.platform === "linux" ? command("unzip", ["-Z1", zip], root)
      : command("tar", ["-tf", zip], root)).trim().split(/\r?\n/);
    if (members.length !== 1 || members[0] !== "workspace.tar.gz") throw new Error("unexpected source product archive");
    if (process.platform === "linux") command("unzip", ["-q", zip, "workspace.tar.gz", "-d", directory], root);
    else command("tar", ["-xf", zip, "-C", directory, "workspace.tar.gz"], root);
    const archive = join(directory, "workspace.tar.gz");
    const outputs = JSON.parse(command("tar", ["-xOzf", archive, "outputs.json"], root)) as Output[];
    const paths = pathsOf(outputs);
    const entries = command("tar", ["-tzf", archive], root).trim().split(/\r?\n/);
    for (const entry of entries) {
      const path = entry.replace(/\/$/, "");
      if (path.split("/").includes("..") || path.includes("\\")
        || (path !== "outputs.json" && !paths.some((output) => path === output || path.startsWith(`${output}/`)))) {
        throw new Error("source archive escapes declared outputs");
      }
    }
    const stage = join(directory, "tree");
    mkdirSync(stage);
    command("tar", ["-xzf", archive, "-C", stage], root);
    assertMaterializedTree(stage);
    for (const path of paths) {
      if (!lstatSync(join(stage, path)).isDirectory()) throw new Error("source output is not a directory");
    }
    for (const path of paths) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      rmSync(destination, { recursive: true, force: true });
      renameSync(join(stage, path), destination);
    }
    return bytes;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function executeSource(options: {
  root: string; scratch: string; pending: Pending; workload: string;
  runUnit: (action: "build" | "result", unit: Unit) => Output;
}): Promise<{ restored: boolean; produced: boolean; bytes: number }> {
  const { root, scratch, pending, workload, runUnit } = options;
  if (pending.protocol !== "nexu-workload-result-v1" || pending.schemaVersion !== 1) throw new Error("unsupported frozen Plan");
  const decision = pending.workloads[workload];
  if (!decision?.scopeEnabled) throw new Error("source workload is not selected");
  mkdirSync(scratch, { recursive: true });
  if (pending.mode === "enforce" && decision.reusable && decision.resultHit && !decision.run) {
    try {
      const products = decision.result?.products;
      if (!products || Object.keys(products).join() !== "bundle" || !products.bundle) throw new Error("missing source product");
      const bytes = await restoreOutputs(root, scratch, products.bundle);
      units.forEach((unit) => runUnit("result", unit));
      return { restored: true, produced: false, bytes };
    } catch (error) {
      console.warn(`::warning::Source restore failed; executing source build: ${String(error)}`);
    }
  } else if (!decision.run) throw new Error("inconsistent frozen source decision");
  const outputs = units.map((unit) => runUnit("build", unit));
  // A failed hit may execute, but must not overwrite its immutable receipt.
  const produced = pending.mode === "enforce" && decision.reusable && decision.run && !decision.resultHit;
  if (produced) archiveOutputs(root, join(scratch, "product"), outputs);
  return { restored: false, produced, bytes: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pendingPath, target, scratch] = process.argv.slice(2);
  const platforms: Record<string, string[]> = { mac_arm64: ["darwin", "arm64"], mac_x64: ["darwin", "x64"], win_x64: ["win32", "x64"] };
  const platform = platforms[target ?? ""];
  if (!pendingPath || !scratch || !platform || platform[0] !== process.platform || platform[1] !== process.arch) throw new Error("source target differs from native executor");
  const root = process.cwd();
  const started = performance.now();
  const result = await executeSource({ root, scratch: resolve(scratch),
    pending: JSON.parse(readFileSync(pendingPath, "utf8")), workload: `source_${target}`,
    runUnit: (action, unit) => JSON.parse(command(process.execPath,
      [join(root, "tools/pack/bin/tools-pack.mjs"), "workspace", action, unit, "--web-output-mode", "standalone", "--json"], root)),
  });
  const report = { ...result, durationMs: Math.round(performance.now() - started) };
  console.log(JSON.stringify(report));
  writeFileSync(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `produced=${result.produced}\nrestored=${result.restored}\n`);
}
