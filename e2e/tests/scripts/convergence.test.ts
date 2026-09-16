import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const convergenceScript = path.join(repoRoot, ".github/scripts/convergence.py");
const temporaryRoots: string[] = [];

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "convergence-contract-"));
  temporaryRoots.push(root);
  for (const [name, content] of [["control.txt", "control"], ["a.txt", "a"], ["b.txt", "b"]] as const) {
    writeFileSync(path.join(root, name), content);
  }
  const configPath = path.join(root, "convergence.json");
  writeFileSync(configPath, JSON.stringify({
    schema: { version: 5 },
    suites: { "convergence-control": ["control.txt"], web: ["a.txt"] },
    workflows: {
      ci: {
        policy: "test-v1",
        workloads: {
          a: { inputs: ["suite://web"], runnerClass: "worker", products: "none", reusable: true, success: { "Job a": ["Execute"] } },
          b: { inputs: ["suite://web", "b.txt"], runnerClass: "worker", products: "none", reusable: true, success: { "Job b": ["Execute"] } },
        },
      },
    },
  }));
  const scopePlanPath = path.join(root, "scope-plan.json");
  writeFileSync(scopePlanPath, JSON.stringify({ enabled: { a: true, b: true } }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
  return { root, configPath, scopePlanPath, pendingPath: path.join(root, "pending.json") };
}

function runPlan(fixture: ReturnType<typeof createRepository>, runner = ["ubuntu-24.04"]) {
  const outputPath = path.join(fixture.root, "github-output.txt");
  writeFileSync(outputPath, "");
  const stdout = execFileSync("python3", [
    convergenceScript, "--root", fixture.root, "--config", fixture.configPath,
    "github-output", "--workflow", "ci", "--scope-plan", fixture.scopePlanPath,
    "--runner-plan-json", JSON.stringify({ worker: runner }), "--repository-id", "42",
    "--repository", "example/repo", "--mode", "shadow", "--pending", fixture.pendingPath,
  ], { cwd: fixture.root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputPath } });
  return {
    decision: JSON.parse(stdout) as { run: Record<string, boolean>; hit: Record<string, boolean> },
    pending: JSON.parse(readFileSync(fixture.pendingPath, "utf8")) as {
      workloads: Record<string, { digest: string; wouldRun: boolean }>;
    },
  };
}

function workload(
  plan: ReturnType<typeof runPlan>["pending"]["workloads"],
  name: string,
) {
  const result = plan[name];
  if (!result) throw new Error(`missing workload ${name}`);
  return result;
}

function candidate(products: Record<string, unknown>) {
  const digest = "d".repeat(64);
  const provenance = {
    event: "pull_request", runId: 12, runAttempt: 1,
    headSha: "a".repeat(40), baseSha: "b".repeat(40), treeSha: "c".repeat(40),
    validatedAt: "2026-08-21T00:00:00Z",
  };
  return {
    schemaVersion: 1,
    protocol: "nexu-workload-result-v1",
    repositoryId: 42,
    repository: "example/repo",
    workflow: "ci",
    policy: "test-v1",
    provenance,
    results: [{
      key: `workload-results/v1/repos/42/workflows/ci/policies/test-v1/workloads/a/digests/${digest}.json`,
      receipt: {
        schemaVersion: 1, protocol: "nexu-workload-result-v1", repositoryId: 42,
        workflow: "ci", policy: "test-v1", workload: "a", digest,
        executionClass: { runnerClass: "worker", labels: ["ubuntu-24.04"] }, products, validated: provenance,
      },
    }],
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workload convergence", () => {
  test("beta source identity follows its execution action, not release transport", () => {
    const result = spawnSync("python3", ["-c", `
import os, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
contract = c.ConvergenceContract(root / ".github/config/convergence-beta.json")
with tempfile.TemporaryDirectory(prefix="beta-source-identity-") as scratch:
    index = Path(scratch) / "index"
    env = {**os.environ, "GIT_INDEX_FILE": str(index)}
    def git(*args, content=None):
        return subprocess.check_output(["git", *args], cwd=root, env=env, input=content, text=True).strip()
    def identity():
        return c.calculate(contract, root, "release-beta", {"source_mac_arm64": ["macos-14"]},
                           index=index, identities={"source_mac_arm64"})["source_mac_arm64"]["digest"]
    def change(path):
        original = git("show", "HEAD:" + path)
        oid = git("hash-object", "-w", "--stdin", content=original + "\\n# witness change\\n")
        git("update-index", "--add", "--cacheinfo", "100644," + oid + "," + path)
    git("read-tree", "HEAD")
    baseline = identity()
    change(".github/workflows/release-beta.yml")
    assert identity() == baseline, "release transport invalidated source products"
    git("read-tree", "HEAD")
    change(".github/actions/workspace-products/action.yml")
    assert identity() != baseline, "source execution change reused stale products"
`, path.dirname(convergenceScript), repoRoot], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  test("projects declared JSON fields from Git without coupling product code to Plan", () => {
    const fixture = createRepository();
    const resourcePath = path.join(fixture.root, "release.json");
    const raw = JSON.parse(readFileSync(fixture.configPath, "utf8"));
    raw.resources = {
      source: { paths: ["a.txt", "release.json"], exclude: ["release.json"] },
      execution: { json: "release.json", omit: ["version"] },
      publication: { json: "release.json", omit: [] },
    };
    raw.workflows.ci.workloads.a.inputs = ["resource://source", "resource://execution"];
    raw.workflows.ci.workloads.b.inputs = ["resource://publication"];
    writeFileSync(fixture.configPath, JSON.stringify(raw));
    const stage = (value: object) => {
      writeFileSync(resourcePath, JSON.stringify(value));
      execFileSync("git", ["add", "release.json"], { cwd: fixture.root });
    };
    stage({ version: "0.22.1", channel: "beta", scripts: { build: "build" } });
    const before = runPlan(fixture).pending.workloads;
    stage({ version: "0.22.3", channel: "beta", scripts: { build: "build" } });
    const version = runPlan(fixture).pending.workloads;
    expect(workload(version, "a").digest).toBe(workload(before, "a").digest);
    expect(workload(version, "b").digest).not.toBe(workload(before, "b").digest);
    // An unstaged edit must not affect the authenticated Git input snapshot.
    writeFileSync(resourcePath, '{"version":"bad","channel":"stable"}');
    expect(runPlan(fixture).pending.workloads).toEqual(version);
    for (const value of [
      { version: "0.22.3", channel: "stable", scripts: { build: "build" } },
      { version: "0.22.3", channel: "beta", scripts: { build: "different" } },
      { version: "0.22.3", channel: "beta", scripts: { build: "build" }, newDependency: "x" },
    ]) {
      stage(value);
      expect(workload(runPlan(fixture).pending.workloads, "a").digest).not.toBe(workload(version, "a").digest);
    }
    stage({ channel: "beta" });
    expect(() => runPlan(fixture)).toThrow(/lacks omitted field version/);
  });

  test("selects the declared release workloads without manufacturing a parallel scope config", () => {
    const fixture = createRepository();
    const output = execFileSync("python3", [convergenceScript, "--root", fixture.root,
      "--config", fixture.configPath, "github-output", "--workflow", "ci", "--all-workloads",
      "--runner-plan-json", '{"worker":["ubuntu-24.04"]}', "--repository-id", "42",
      "--repository", "example/repo", "--mode", "enforce", "--pending", fixture.pendingPath],
    { cwd: fixture.root, encoding: "utf8", env: { ...process.env, OD_WORKLOAD_RESULTS_BASE_URL: "",
      GITHUB_OUTPUT: path.join(fixture.root, "outputs"), GITHUB_STEP_SUMMARY: path.join(fixture.root, "summary") } });
    expect(JSON.parse(output).run).toEqual({ a: true, b: true });
    expect(readFileSync(path.join(fixture.root, "outputs"), "utf8")).toContain("expects_contributions=true");
  });

  test("does not collect receipts for all-hit or out-of-scope workloads", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", ["-c", `
import os, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
args = ["convergence", "--root", str(root), "--config", str(root / "convergence.json"),
        "github-output", "--workflow", "ci", "--all-workloads",
        "--runner-plan-json", '{"worker":["ubuntu-24.04"]}', "--repository-id", "42",
        "--repository", "example/repo", "--mode", "enforce", "--pending", str(root / "pending.json")]
for mode in ("enforce", "shadow"):
    args[args.index("--mode") + 1] = mode
    with patch.object(sys, "argv", args), patch("convergence.resolve_results", return_value=(
            {"a": True, "b": True}, {"a": "result-hit", "b": "result-hit"}, {})), \\
            patch("convergence.append_outputs") as outputs:
        assert c.main() == 0
        assert outputs.call_args.args[0]["expects_contributions"] == "false"
`, path.dirname(convergenceScript), fixture.root], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    writeFileSync(fixture.scopePlanPath, JSON.stringify({ enabled: { a: false, b: false } }));
    runPlan(fixture);
    expect(readFileSync(path.join(fixture.root, "github-output.txt"), "utf8")).toContain("expects_contributions=false");
  });

  test("admits only the named beta policy under the existing isolated branch authorization", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", ["-c", `
import copy, os, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import convergence as c
with patch.dict(os.environ, {"GITHUB_EVENT_NAME":"workflow_dispatch", "GITHUB_REPOSITORY":"nexu-io/open-design", "GITHUB_REF":"refs/heads/feat/plan-foundation", "GITHUB_REPOSITORY_ID":"42", "GITHUB_RUN_ID":"12", "GITHUB_RUN_ATTEMPT":"1"}):
    with patch("convergence.event_payload", return_value={"repository":{"id":42}}):
        context = c.producer_context(c.event_payload())
        candidate = {**context, "workflow":"release-beta", "policy":"beta-isolated-v1"}
        with patch("convergence.prepare_publication") as validation:
            c.require_isolated_candidate(candidate)
            validation.assert_called_once()
            for mutation in ("policy", "workflow", "headSha", "runAttempt"):
                forged = copy.deepcopy(candidate)
                if mutation == "policy": forged[mutation] = "production-v1"
                elif mutation == "workflow": forged[mutation] = "release-stable"
                elif mutation == "headSha": forged["provenance"][mutation] = "f" * 40
                else: forged["provenance"][mutation] = 2
                try: c.require_isolated_candidate(forged)
                except c.ConfigError: pass
                else: raise AssertionError("accepted " + mutation)
`, path.dirname(convergenceScript)], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  test("shares only explicit identical recipes from declared producers, preserving isolation otherwise", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", ["-c", `
import copy, json, sys, urllib.error
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
path = root / "convergence.json"
raw = json.loads(path.read_text())
raw["workflows"]["release-stable"] = copy.deepcopy(raw["workflows"]["ci"])
raw["workflows"]["release-stable"]["policy"] = "stable-v1"
path.write_text(json.dumps(raw))
contract = c.ConvergenceContract(path)
runners = {"worker": ["ubuntu-24.04"]}
assert c.calculate(contract, root, "ci", runners)["a"]["digest"] != c.calculate(contract, root, "release-stable", runners)["a"]["digest"]
source = {"workflow": "ci", "policy": "test-v1", "workload": "a"}
for workflow in raw["workflows"].values():
    workflow["workloads"]["a"]["recipe"] = "shared-test"
raw["workflows"]["release-stable"]["workloads"]["a"]["trustedSources"] = [source]
path.write_text(json.dumps(raw))
contract = c.ConvergenceContract(path)
producer = c.calculate(contract, root, "ci", runners)["a"]
consumer = c.calculate(contract, root, "release-stable", runners)["a"]
assert producer["digest"] == consumer["digest"]
receipt = json.loads(sys.argv[3])["results"][0]["receipt"]
receipt["digest"] = producer["digest"]
workflow = contract.workflow("release-stable")
c.validate_result(receipt, repository_id=42, workflow=workflow, identity="a", expected=consumer)
urls = []
def fetch(url, timeout):
    urls.append(url)
    if "/workflows/release-stable/" in url: raise urllib.error.HTTPError(url, 404, "missing", {}, None)
    return receipt
with patch("convergence.fetch_result", side_effect=fetch):
    hits, _, results = c.resolve_results("https://results.example", 42, workflow, {"a": consumer}, 1)
    assert hits == {"a": True} and len(urls) == 2
    assert results["a"]["workflow"] == "ci", "producer provenance was relabelled"
for mutation in ("no-trust", "policy", "recipe", "runner", "steps", "input"):
    changed = copy.deepcopy(consumer)
    value = copy.deepcopy(receipt)
    if mutation == "no-trust": changed["trustedSources"] = []
    if mutation == "policy": value["policy"] = "untrusted-v1"
    if mutation == "recipe": changed["digest"] = "f" * 64
    if mutation == "runner": value["executionClass"]["labels"] = ["other-os"]
    if mutation in ("steps", "input"):
        edited = copy.deepcopy(raw)
        declaration = edited["workflows"]["release-stable"]["workloads"]["a"]
        if mutation == "steps": declaration["success"]["Job a"].append("Additional coverage")
        else: declaration["inputs"].append("b.txt")
        path.write_text(json.dumps(edited))
        changed = c.calculate(c.ConvergenceContract(path), root, "release-stable", runners)["a"]
    try: c.validate_result(value, repository_id=42, workflow=workflow, identity="a", expected=changed)
    except c.ConfigError: pass
    else: raise AssertionError("accepted " + mutation)
# Shared recipe names cannot alias different declared inputs in one calculate call.
edited = copy.deepcopy(raw)
edited["workflows"]["ci"]["workloads"]["b"] = copy.deepcopy(edited["workflows"]["ci"]["workloads"]["a"])
edited["workflows"]["ci"]["workloads"]["b"]["inputs"].append("b.txt")
path.write_text(json.dumps(edited))
calculated = c.calculate(c.ConvergenceContract(path), root, "ci", runners)
assert calculated["a"]["digest"] != calculated["b"]["digest"]
`, path.dirname(convergenceScript), fixture.root, JSON.stringify(candidate({}))], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  test("repeated publication sends no product PUT and rejects changed bytes before writes", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", ["-c", `
import argparse, copy, json, sys, zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
candidate = json.loads(sys.argv[3])
source = root / "build.zip"
with zipfile.ZipFile(source, "w") as archive: archive.writestr("entry.txt", "original")
path = root / "candidate.json"
path.write_text(json.dumps(candidate))
args = argparse.Namespace(isolated=False, candidate=path, products_root=root, output_dir=root / "out", timeout=1)
storage = {"endpoint": "https://r2.example", "bucket": "test", "access_key_id": "test", "secret_access_key": "test", "public_origin": "https://results.example"}
objects = {}
writes = []
def put(*, key, file, **kwargs):
    writes.append(key)
    objects[key] = file.read_bytes()
def get(url, timeout):
    body = objects.get(url.removeprefix("https://results.example/"))
    return json.loads(body) if body is not None else None
with patch("convergence.storage_config", return_value=storage), patch.object(c.R2Client, "put_file", side_effect=put), patch("convergence.existing_receipt", side_effect=get):
    c.publish_command(args)
    assert len(writes) == 2 and writes[0].startswith("workload-products/") and writes[1].startswith("workload-results/")
    writes.clear()
    candidate["provenance"]["runId"] = 13
    candidate["results"][0]["receipt"]["validated"]["runId"] = 13
    path.write_text(json.dumps(candidate))
    c.publish_command(args)
    assert writes == [], "repeated result reuploaded a product"
    with zipfile.ZipFile(source, "w") as archive: archive.writestr("entry.txt", "different")
    try: c.publish_command(args)
    except c.ConfigError as error: assert "collision" in str(error)
    else: raise AssertionError("accepted different product content under one recipe")
    assert writes == [], "collision caused a write before validation"
`, path.dirname(convergenceScript), fixture.root, JSON.stringify(candidate({ bundle: { type: "job", source: "build" } }))], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"uploadedProductBytes": 0');
  });

  test("reads all jobs from the exact attempt and rejects malformed API responses", () => {
    const result = spawnSync("python3", ["-c", `
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from lib import github as g
with patch.object(g, "api_json", side_effect=[{"jobs": [{"id": i} for i in range(100)]}, {"jobs": [{"id": 100}]}]) as api:
    assert len(g.run_jobs("example/repo", 12, 2)) == 101
    assert [call.args[0] for call in api.call_args_list] == [
        f"/repos/example/repo/actions/runs/12/attempts/2/jobs?per_page=100&page={page}" for page in (1, 2)]
for response in ({}, {"jobs": None}, {"jobs": [None]}):
    with patch.object(g, "api_json", return_value=response):
        try: g.run_jobs("example/repo", 12, 2)
        except g.GitHubError: pass
        else: raise AssertionError("accepted invalid jobs response")
`, path.dirname(convergenceScript)], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  test("contributes independent successes but rejects forged successful-step evidence", () => {
    const fixture = createRepository();
    runPlan(fixture);
    const result = spawnSync("python3", ["-c", `
import copy, json, subprocess, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
contract = c.ConvergenceContract(root / "convergence.json")
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip()
provenance = {"event": "workflow_dispatch", "runId": 12, "runAttempt": 1, "headSha": head,
              "baseSha": head, "treeSha": tree, "validatedAt": "2026-09-15T00:00:00Z"}
jobs = [{"id": i, "name": f"Job {name}", "run_id": 12, "run_attempt": 1, "head_sha": head,
         "status": "completed", "conclusion": "success" if name == "a" else "failure",
         "labels": ["ubuntu-24.04"],
         "steps": [{"name": "Execute", "status": "completed", "conclusion": "success"}]}
        for i, name in enumerate(("a", "b"), 1)]
# Failed b has no manifest. Its absence must not suppress successful a.
contract.workflow("ci").workloads["b"].products = "manifest"
candidate = c.finalize_candidate(root / "pending.json", provenance, root / "products", contract, jobs)
assert [item["receipt"]["workload"] for item in candidate["results"]] == ["a"]
with patch("convergence.run_jobs", return_value=jobs):
    c.validate_admitted_plan(candidate, contract, root, tree)
for mutation in ("step", "attempt", "missing", "duplicate"):
    bad = copy.deepcopy(jobs)
    if mutation == "step": bad[0]["steps"][0]["conclusion"] = "skipped"
    if mutation == "attempt": bad[0]["run_attempt"] = 2
    if mutation == "missing": bad = bad[1:]
    if mutation == "duplicate": bad.append(copy.deepcopy(bad[0]))
    with patch("convergence.run_jobs", return_value=bad):
        try: c.validate_admitted_plan(candidate, contract, root, tree)
        except c.ConfigError: pass
        else: raise AssertionError("accepted false success: " + mutation)
before = c.calculate(contract, root, "ci", {"worker": ["ubuntu-24.04"]})["a"]["digest"]
contract.workflow("ci").workloads["a"].success["Job a"].append("Additional validation")
assert c.calculate(contract, root, "ci", {"worker": ["ubuntu-24.04"]})["a"]["digest"] != before
`, path.dirname(convergenceScript), fixture.root], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  test("authenticates PR merge trees and exact parents without changing the trusted checkout", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", ["-c", `
import subprocess, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
def git(*args):
    return subprocess.check_output(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", *args], text=True).strip()
initial = git("rev-parse", "HEAD")
git("checkout", "-qb", "feature")
(root / "a.txt").write_text("feature change")
git("commit", "-qam", "feature")
head = git("rev-parse", "HEAD")
head_tree = git("rev-parse", "HEAD^{tree}")
git("checkout", "-qb", "base", initial)
(root / "b.txt").write_text("base change")
git("commit", "-qam", "base")
base = git("rev-parse", "HEAD")
git("merge", "--no-ff", "--no-edit", "feature")
merge = git("rev-parse", "HEAD")
tree = git("rev-parse", "HEAD^{tree}")
assert tree != head_tree
git("update-ref", "refs/pull/17/merge", merge)
git("remote", "add", "origin", str(root))
git("checkout", "-q", "--detach", base)
index = git("ls-files", "-s")
entry = {"event": "pull_request", "base_sha": base, "head_sha": head, "tree_sha": tree}
payload = {"workflow_run": {"pull_requests": [{"number": 17}]}}
assert c.authenticated_source_tree(entry, payload) == tree
assert git("rev-parse", "HEAD") == base
assert git("ls-files", "-s") == index
for bad in ({**entry, "tree_sha": head_tree}, {**entry, "base_sha": initial}):
    try: c.authenticated_source_tree(bad, payload)
    except c.ConfigError: pass
    else: raise AssertionError("accepted wrong PR snapshot")
for pulls in ([], [{"number": 17}, {"number": 18}], [{"number": "17;echo unsafe"}]):
    try: c.authenticated_source_tree(entry, {"workflow_run": {"pull_requests": pulls}})
    except c.ConfigError: pass
    else: raise AssertionError("accepted ambiguous PR source")
`, path.dirname(convergenceScript), fixture.root], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  test("requires all workload shards and execution steps from the exact producing attempt", () => {
    const result = spawnSync("python3", ["-c", `
import copy, sys
sys.path.insert(0, sys.argv[1])
import convergence as c
provenance = {"runId": 12, "runAttempt": 2, "headSha": "a" * 40}
execution = {"runnerClass": "js_hot", "labels": ["blacksmith-4vcpu-ubuntu-2404"]}
required = {f"Web workspace tests ({i}/2)": ["Prebuild web sidecar declarations", "Web workspace tests"] for i in (1, 2)}
jobs = [{"id": i, "name": name, "run_id": 12, "run_attempt": 2, "head_sha": "a" * 40,
         "status": "completed", "conclusion": "success", "labels": execution["labels"],
         "steps": [{"name": step, "status": "completed", "conclusion": "success"} for step in steps]}
        for i, (name, steps) in enumerate(required.items(), 1)]
assert c.successful_workload_jobs(jobs, required, provenance, execution) == [1, 2]
assert c.successful_workload_jobs(jobs[:1], required, provenance, execution) is None
for state in ("failure", "cancelled", "skipped", None):
    bad = copy.deepcopy(jobs)
    bad[1]["conclusion"] = state
    assert c.successful_workload_jobs(bad, required, provenance, execution) is None
    bad = copy.deepcopy(jobs)
    bad[1]["steps"][1]["conclusion"] = state
    assert c.successful_workload_jobs(bad, required, provenance, execution) is None
for field, value in (("run_id", 13), ("run_attempt", 1), ("head_sha", "b" * 40), ("labels", ["other"]), ("id", 1)):
    bad = copy.deepcopy(jobs)
    bad[1][field] = value
    try: c.successful_workload_jobs(bad, required, provenance, execution)
    except c.ConfigError: pass
    else: raise AssertionError("accepted " + field)
try: c.successful_workload_jobs(jobs + [jobs[1]], required, provenance, execution)
except c.ConfigError: pass
else: raise AssertionError("accepted ambiguous jobs")
print("workload execution boundary passed")
`, path.dirname(convergenceScript)], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  test("binds candidates to trusted snapshot identities without checking out producer code", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", ["-c", `
import copy, json, subprocess, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
contract = c.ConvergenceContract(root / "convergence.json")
runners = {"worker": ["ubuntu-24.04"]}
expected = c.calculate(contract, root, "ci", runners)
tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=root, text=True).strip()
(root / "a.txt").write_text("changed trusted checkout")
subprocess.run(["git", "add", "a.txt"], cwd=root, check=True)
index_before = subprocess.check_output(["git", "diff", "--cached"], cwd=root)
snapshot = c.calculate_snapshot(contract, root, "ci", runners, tree)
assert snapshot == expected
assert c.calculate(contract, root, "ci", runners) != expected
assert subprocess.check_output(["git", "diff", "--cached"], cwd=root) == index_before
candidate = json.loads(sys.argv[3])
receipt = candidate["results"][0]["receipt"]
receipt["digest"] = expected["a"]["digest"]
candidate["results"][0]["key"] = c.result_key(42, "ci", "test-v1", "a", receipt["digest"])
c.validate_candidate_plan(candidate, contract, snapshot)
for mutation in ("digest", "workload", "executionClass", "products", "duplicate"):
    forged = copy.deepcopy(candidate)
    item = forged["results"][0]
    value = item["receipt"]
    if mutation == "digest": value["digest"] = "e" * 64
    if mutation == "workload": value["workload"] = "undeclared"
    if mutation == "executionClass": value["executionClass"]["labels"] = ["forged-runner"]
    if mutation == "products": value["products"] = {"bundle": {"type": "job", "source": "forged"}}
    if mutation == "duplicate": forged["results"].append(copy.deepcopy(item))
    item["key"] = c.result_key(42, "ci", "test-v1", value["workload"], value["digest"])
    try: c.validate_candidate_plan(forged, contract, snapshot)
    except c.ConfigError: pass
    else: raise AssertionError("accepted " + mutation)
print("snapshot and candidate binding passed")
`, path.dirname(convergenceScript), fixture.root, JSON.stringify(candidate({}))], {
      cwd: fixture.root, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("snapshot and candidate binding passed");
  });
  test("rejects isolated writes from unauthorized branches before loading storage credentials", () => {
    const fixture = createRepository();
    const candidatePath = path.join(fixture.root, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate({})));
    const result = spawnSync("python3", [convergenceScript, "publish", "--isolated",
      "--candidate", candidatePath, "--output-dir", path.join(fixture.root, "published"),
      "--products-root", path.join(fixture.root, "products")], {
      cwd: fixture.root, encoding: "utf8", env: { ...process.env,
        GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "nexu-io/open-design",
        GITHUB_REF: "refs/heads/main" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("authorized manual branch");
    expect(result.stderr).not.toContain("storage is missing");
  });
  test("isolates local declarations from admission controls and rejects stale identity schemas", () => {
    const fixture = createRepository();
    const before = runPlan(fixture).pending.workloads;
    writeFileSync(path.join(fixture.root, "control.txt"), "new admission code");
    execFileSync("git", ["add", "control.txt"], { cwd: fixture.root });
    expect(runPlan(fixture).pending.workloads).toEqual(before);
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8"));
    config.workflows.ci.workloads.b.inputs = ["b.txt"];
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const after = runPlan(fixture).pending.workloads;
    expect(workload(after, "a").digest).toBe(workload(before, "a").digest);
    expect(workload(after, "b").digest).not.toBe(workload(before, "b").digest);
    config.schema.version = 1;
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const stale = spawnSync("python3", [convergenceScript, "--root", fixture.root,
      "--config", fixture.configPath, "validate"], { encoding: "utf8" });
    expect(stale.status).toBe(2);
    expect(stale.stderr).toContain("requires schema.version 5");
  });
  test("rejects restoring a miss instead of manufacturing successful output", () => {
    const fixture = createRepository();
    runPlan(fixture);
    const result = spawnSync("python3", [
      convergenceScript, "--root", fixture.root, "--config", fixture.configPath,
      "restore", "--pending", fixture.pendingPath, "--workload", "a",
      "--output-dir", path.join(fixture.root, "restored"),
    ], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("restore requires a selected reusable-result hit");
  });

  test("checks complete product restoration and failed-set isolation without network", () => {
    const fixture = createRepository();
    const result = spawnSync("python3", [
      convergenceScript, "--root", fixture.root, "--config", fixture.configPath, "validate",
    ], { cwd: fixture.root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("convergence configuration is valid");
  });

  test("keeps shadow coverage while calculating stable workload identities", () => {
    const fixture = createRepository();
    const first = runPlan(fixture);
    const second = runPlan(fixture);
    expect(first.decision.run).toEqual({ a: true, b: true });
    expect(first.decision.hit).toEqual({ a: false, b: false });
    expect(workload(second.pending.workloads, "a").digest).toBe(workload(first.pending.workloads, "a").digest);
    expect(workload(second.pending.workloads, "b").digest).toBe(workload(first.pending.workloads, "b").digest);
  });

  test("composes suites without coupling unrelated workload inputs", () => {
    const fixture = createRepository();
    const before = runPlan(fixture).pending.workloads;
    writeFileSync(path.join(fixture.root, "b.txt"), "b2");
    execFileSync("git", ["add", "b.txt"], { cwd: fixture.root });
    const afterB = runPlan(fixture).pending.workloads;
    expect(workload(afterB, "a").digest).toBe(workload(before, "a").digest);
    expect(workload(afterB, "b").digest).not.toBe(workload(before, "b").digest);

    writeFileSync(path.join(fixture.root, "a.txt"), "a2");
    execFileSync("git", ["add", "a.txt"], { cwd: fixture.root });
    const afterA = runPlan(fixture).pending.workloads;
    expect(workload(afterA, "a").digest).not.toBe(workload(afterB, "a").digest);
    expect(workload(afterA, "b").digest).not.toBe(workload(afterB, "b").digest);
  });

  test("includes the execution class in the reusable-result digest", () => {
    const fixture = createRepository();
    const hostedPlan = runPlan(fixture, ["ubuntu-24.04"]).pending.workloads;
    const arcPlan = runPlan(fixture, ["nexu-runners-medium"]).pending.workloads;
    const hosted = workload(hostedPlan, "a").digest;
    const arc = workload(arcPlan, "a").digest;
    expect(arc).not.toBe(hosted);
  });

  test("keeps broad test workloads on tracked-tree inputs until their closure is proven", () => {
    const config = JSON.parse(readFileSync(
      path.join(repoRoot, ".github", "config", "convergence.json"),
      "utf8",
    )) as any;

    expect(config.workflows.ci.workloads.daemon_unit_tests.inputs).toEqual(["*"]);
    expect(config.workflows.ci.workloads.e2e_vitest.inputs).toEqual(["*"]);
  });

  test("materializes the convergence handoff from the GitHub event context", () => {
    const fixture = createRepository();
    runPlan(fixture);
    const eventPath = path.join(fixture.root, "event.json");
    const outputPath = path.join(fixture.root, "handoff-output.txt");
    const handoffRoot = path.join(fixture.root, "handoff-root");
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim();
    writeFileSync(eventPath, JSON.stringify({
      repository: { id: 42, full_name: "example/repo" },
      pull_request: { head: { sha: headSha }, base: { sha: headSha } },
    }));
    writeFileSync(outputPath, "");
    const jobs = ["a", "b"].map((name, index) => ({
      id: index + 1, name: `Job ${name}`, run_id: 12, run_attempt: 1, head_sha: headSha,
      status: "completed", conclusion: "success", labels: ["ubuntu-24.04"],
      steps: [{ name: "Execute", status: "completed", conclusion: "success" }],
    }));
    const jobsPath = path.join(fixture.root, "jobs.json");
    writeFileSync(jobsPath, JSON.stringify(jobs));
    execFileSync("python3", ["-c", `
import json, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv.pop(1))
jobs = json.loads(open(sys.argv.pop(1)).read())
import convergence as c
with patch("convergence.run_jobs", return_value=jobs):
    raise SystemExit(c.main())
`, path.dirname(convergenceScript), jobsPath, "--root", fixture.root, "--config", fixture.configPath,
      "handoff", "--pending", fixture.pendingPath,
      "--products-root", path.join(fixture.root, "products"),
      "--handoff-root", handoffRoot,
    ], {
      cwd: fixture.root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_REPOSITORY_ID: "42",
        GITHUB_RUN_ID: "12",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: outputPath,
      },
    });
    const metadata = JSON.parse(readFileSync(
      path.join(handoffRoot, "handoff", "convergence", "ci-results", "metadata.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      repository_id: 42, repository: "example/repo", workflow: "ci", policy: "test-v1",
      event: "workflow_dispatch", run_id: 12, run_attempt: 1, head_sha: headSha,
    });
    expect(readFileSync(outputPath, "utf8")).toContain("name=handoff-convergence-ci-results");

    writeFileSync(eventPath, JSON.stringify({
      repository: { id: 42, full_name: "example/repo" },
      workflow_run: {
        id: 12, run_attempt: 1, name: "ci", event: "workflow_dispatch", head_sha: headSha,
        head_repository: { full_name: "example/repo" },
      },
    }));
    writeFileSync(outputPath, "");
    execFileSync("git", ["remote", "add", "origin", fixture.root], { cwd: fixture.root });
    const admission = spawnSync("python3", ["-c", `
import argparse, copy, json, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import convergence as c
root = Path(sys.argv[2])
args = argparse.Namespace(root=root, isolated=False, handoff_root=Path(sys.argv[3]))
contract = c.ConvergenceContract(root / "convergence.json")
candidate_path = args.handoff_root / "handoff/convergence/ci-results/candidate.json"
original = json.loads(candidate_path.read_text())
with patch("convergence.run_jobs", return_value=json.loads((root / "jobs.json").read_text())):
    assert c.admit_command(args, contract) == 0
    for field in ("digest", "executionClass", "treeSha", "workload"):
        forged = copy.deepcopy(original)
        receipt = forged["results"][0]["receipt"]
        if field == "digest": receipt["digest"] = "e" * 64
        if field == "executionClass": receipt["executionClass"]["labels"] = ["invented-runner"]
        if field == "workload": receipt["workload"] = "undeclared"
        if field == "treeSha":
            forged["provenance"]["treeSha"] = "f" * 40
            for result in forged["results"]: result["receipt"]["validated"]["treeSha"] = "f" * 40
        forged["results"][0]["key"] = c.result_key(42, "ci", "test-v1", receipt["workload"], receipt["digest"])
        candidate_path.write_text(json.dumps(forged))
        metadata_path = candidate_path.parent / "metadata.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["tree_sha"] = forged["provenance"]["treeSha"]
        metadata_path.write_text(json.dumps(metadata))
        try: c.admit_command(args, contract)
        except c.ConfigError: pass
        else: raise AssertionError("admission accepted forged " + field)
`, path.dirname(convergenceScript), fixture.root, handoffRoot], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    });
    expect(admission.status, admission.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("publish=true");
  });

  test("rejects dependency cycles and dangling suites before planning", () => {
    const fixture = createRepository();
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as any;
    config.suites.web = ["suite://web"];
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const cycle = spawnSync("python3", [
      convergenceScript, "--root", fixture.root, "--config", fixture.configPath, "validate",
    ], { cwd: fixture.root, encoding: "utf8" });
    expect(cycle.status).toBe(2);
    expect(cycle.stderr).toContain("convergence dependency cycle");

    config.suites.web = ["suite://missing"];
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const dangling = spawnSync("python3", [
      convergenceScript, "--root", fixture.root, "--config", fixture.configPath, "validate",
    ], { cwd: fixture.root, encoding: "utf8" });
    expect(dangling.status).toBe(2);
    expect(dangling.stderr).toContain("references unknown suite://missing");
  });

  test("publishes a multi-product manifest atomically only after every product is a URL", () => {
    const root = mkdtempSync(path.join(tmpdir(), "convergence-products-"));
    temporaryRoots.push(root);
    const candidatePath = path.join(root, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate({
      bundle: { type: "url", source: "https://results.example/bundle.zip", data: { sha256: "a".repeat(64) } },
      report: { type: "url", source: "https://results.example/report.json" },
    })));
    execFileSync("python3", [
      convergenceScript, "prepare-publication", "--candidate", candidatePath,
      "--output-dir", path.join(root, "receipts"),
    ], { cwd: repoRoot });

    writeFileSync(candidatePath, JSON.stringify(candidate({
      bundle: { type: "job", source: "build-products" },
      report: { type: "url", source: "https://results.example/report.json" },
    })));
    const rejected = spawnSync("python3", [
      convergenceScript, "prepare-publication", "--candidate", candidatePath,
      "--output-dir", path.join(root, "rejected"),
    ], { cwd: repoRoot, encoding: "utf8" });
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("must be promoted to url before publication");
  });
});
