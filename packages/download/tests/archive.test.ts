import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { archiveExecutable, createTarArchive, extractArchive, listArchive, readTarEntry } from "../src/archive.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("uses injected native tools and avoids Windows Git Bash tar", () => {
  expect(archiveExecutable("win32", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\tar.exe");
  expect(archiveExecutable("win32", { OD_ARCHIVE_TAR: "custom-tar" })).toBe("custom-tar");
  expect(() => archiveExecutable("win32", {})).toThrow("SystemRoot");
});

it("round-trips a native tar archive without workspace or platform policy", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-test-")); roots.push(root);
  const source = join(root, "source"), destination = join(root, "destination"), archive = join(root, "blob.tar.gz");
  mkdirSync(source); mkdirSync(destination); writeFileSync(join(source, "entry.js"), "export {};\n");
  createTarArchive(archive, [{ directory: source, entries: ["entry.js"] }]);
  expect(listArchive(archive, "tar.gz")).toEqual(["entry.js"]);
  expect(readTarEntry(archive, "entry.js")).toBe("export {};\n");
  extractArchive(archive, destination, "tar.gz");
  expect(readFileSync(join(destination, "entry.js"), "utf8")).toBe("export {};\n");
  expect(() => readTarEntry(archive, "../escape")).toThrow("unsafe archive entry");
});
