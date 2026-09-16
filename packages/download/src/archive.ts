import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

export type ArchiveFormat = "tar.gz" | "zip";

/** Native archive tools are injected by callers/environment, never installed here. */
export function archiveExecutable(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OD_ARCHIVE_TAR) return env.OD_ARCHIVE_TAR;
  if (platform !== "win32") return "tar";
  if (!env.SystemRoot || !win32.isAbsolute(env.SystemRoot)) throw new Error("Windows SystemRoot is required for native tar");
  // Avoid Git Bash GNU tar treating drive letters as remote archive hosts.
  return win32.join(env.SystemRoot, "System32", "tar.exe");
}

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`archive tool failed (${result.signal ?? result.status}): ${result.stderr}`);
  return result.stdout;
}

function validateEntry(entry: string): void {
  if (!entry || entry.startsWith("/") || entry.includes("\\") || entry.includes(":")
    || entry.split("/").includes("..") || entry.startsWith("-")) throw new Error(`unsafe archive entry: ${entry}`);
}

export function listArchive(archive: string, format: ArchiveFormat): string[] {
  const listing = format === "zip" && process.platform === "linux"
    ? run(process.env.OD_ARCHIVE_UNZIP || "unzip", ["-Z1", archive])
    : run(archiveExecutable(), ["-tf", archive]);
  const entries = listing.trim().split(/\r?\n/).filter(Boolean);
  entries.forEach(validateEntry);
  return entries;
}

/** Caller supplies a fresh staging directory and validates its application manifest. */
export function extractArchive(archive: string, destination: string, format: ArchiveFormat, entries?: string[]): void {
  (entries ?? listArchive(archive, format)).forEach(validateEntry);
  if (format === "zip" && process.platform === "linux") {
    run(process.env.OD_ARCHIVE_UNZIP || "unzip", ["-q", archive, ...(entries ?? []), "-d", destination]);
  } else {
    run(archiveExecutable(), ["-xf", archive, "-C", destination, ...(entries ?? [])]);
  }
}

export function readTarEntry(archive: string, entry: string): string {
  validateEntry(entry);
  return run(archiveExecutable(), ["-xOf", archive, entry]);
}

/** Dereference producer-owned links so consumers do not inherit pnpm symlinks. */
export function createTarArchive(archive: string, sources: { directory: string; entries: string[] }[]): void {
  const args = sources.flatMap(({ directory, entries }) => {
    entries.forEach(validateEntry);
    return ["-C", directory, ...entries];
  });
  run(archiveExecutable(), ["-czhf", archive, ...args]);
}
