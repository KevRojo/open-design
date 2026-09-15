import { spawn } from "node:child_process";

import { createPackageManagerInvocation } from "@open-design/platform";

import { WORKSPACE_ROOT } from "../config/index.js";
import { runWorkspaceBuildUnit, workspaceBuildUnitResult, type WorkspaceBuildConfig } from "../workspace-build.js";
import { parseWorkspaceBuildUnit } from "./units.js";

export async function workspaceCommand(action: string, value: string, options: { webOutputMode?: string }) {
  const startedAt = performance.now();
  const unit = parseWorkspaceBuildUnit(value);
  if (action !== "build" && action !== "result") throw new Error(`unsupported workspace action: ${action}`);
  const webOutputMode = options.webOutputMode ?? "standalone";
  if (webOutputMode !== "standalone" && webOutputMode !== "server") throw new Error(`unsupported web output mode: ${webOutputMode}`);
  const config: WorkspaceBuildConfig = { workspaceRoot: WORKSPACE_ROOT, webOutputMode };
  if (action === "build") {
    await runWorkspaceBuildUnit(config, unit, async (args, extraEnv) => {
      const invocation = createPackageManagerInvocation(args, process.env);
      process.stderr.write(`[tools-pack workspace] ${unit}: pnpm ${args.join(" ")}\n`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: config.workspaceRoot,
          env: { ...process.env, ...extraEnv },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
        child.stdout?.pipe(process.stderr, { end: false });
        child.stderr?.pipe(process.stderr, { end: false });
        child.once("error", reject);
        child.once("close", (code, signal) => code === 0 && signal === null
          ? resolve() : reject(new Error(`workspace ${unit} failed: ${signal ?? code}`)));
      });
    });
  }
  const result = await workspaceBuildUnitResult(config, unit);
  process.stderr.write(`[tools-pack workspace] ${action} ${unit} durationMs=${Math.round(performance.now() - startedAt)}\n`);
  return result;
}
