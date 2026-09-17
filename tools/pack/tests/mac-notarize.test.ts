import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const source = await readFile(new URL("../resources/mac/notarize.cjs", import.meta.url), "utf8");

function fixture(status = "Accepted") {
  const calls: string[][] = [];
  const log = vi.fn();
  const remove = vi.fn(async () => {});
  const spawn = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      if (args[0] === "notarytool") child.stdout.emit("data", Buffer.from(JSON.stringify({ status })));
      child.emit("close", 0);
    });
    return child;
  };
  const modules: Record<string, unknown> = {
    "node:path": path,
    "node:fs/promises": { mkdtemp: async () => "/temporary/notarize", rm: remove },
    "node:os": { tmpdir: () => "/temporary" },
    "node:child_process": { spawn },
  };
  const module = { exports: undefined as unknown };
  runInNewContext(source, {
    module, require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`);
      return modules[name];
    },
    process: { env: { APPLE_ID: "test", APPLE_APP_SPECIFIC_PASSWORD: "secret-sentinel", APPLE_TEAM_ID: "team" } },
    console: { error: log, warn: log }, Buffer, performance,
  });
  const run = module.exports as (context: unknown) => Promise<void>;
  return { calls, log, remove, run: () => run({
    electronPlatformName: "darwin", appOutDir: "/output",
    packager: { appInfo: { productFilename: "Open Design Beta" } },
  }) };
}

describe("mac notarization hook", () => {
  it("submits once, staples, and reports stages without credentials", async () => {
    const f = fixture();
    await f.run();
    expect(f.calls.map(([command, action]) => [command, action])).toEqual([
      ["ditto", "-c"], ["xcrun", "notarytool"], ["xcrun", "stapler"],
    ]);
    const logs = f.log.mock.calls.flat().join("\n");
    for (const phase of ["archive", "submit-and-wait", "staple", "cleanup"]) {
      expect(logs).toContain(`phase:done phase=${phase} durationMs=`);
    }
    expect(logs).not.toContain("secret-sentinel");
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it("fails closed on rejection, skips stapling, and still cleans up", async () => {
    const f = fixture("Invalid");
    await expect(f.run()).rejects.toThrow("Failed to notarize via notarytool");
    expect(f.calls).toHaveLength(2);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.log.mock.calls.flat().join("\n")).toContain("phase:failed phase=submit-and-wait");
  });
});
