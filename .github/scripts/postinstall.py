#!/usr/bin/env python3

"""Produce and consume frozen workspace-initialization plans for workflows."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
INSTALL_PROFILES = {"workspace", "source-web", "release-executor", "mac-runtime"}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def load_object(path: Path, label: str) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def append_outputs(values: dict[str, str]) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def target_catalog(root: Path) -> list[str]:
    config = load_object(root / "scripts/postinstall.config.json", "postinstall local config")
    if config.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("postinstall local config has an unsupported schemaVersion")
    local = config.get("localDevelopment")
    if not isinstance(local, dict):
        raise ValueError("postinstall local config requires localDevelopment")
    targets = local.get("targets")
    if not isinstance(targets, list) or not targets or any(not isinstance(item, str) or not item for item in targets):
        raise ValueError("postinstall local config requires non-empty string targets")
    if len(set(targets)) != len(targets):
        raise ValueError("postinstall local targets must be unique")
    return targets


def package_manifest(root: Path, target: str) -> dict[str, Any]:
    return load_object(root / target / "package.json", f"{target}/package.json")


def dependency_map(root: Path, targets: list[str]) -> dict[str, list[str]]:
    names: dict[str, str] = {}
    manifests: dict[str, dict[str, Any]] = {}
    for target in targets:
        manifest = package_manifest(root, target)
        manifests[target] = manifest
        name = manifest.get("name")
        if isinstance(name, str) and name:
            names[name] = target

    result: dict[str, list[str]] = {}
    for target in targets:
        dependencies: list[str] = []
        manifest = manifests[target]
        for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            values = manifest.get(field, {})
            if not isinstance(values, dict):
                continue
            for name, specifier in values.items():
                dependency = names.get(name)
                if dependency and isinstance(specifier, str) and specifier.startswith("workspace:"):
                    dependencies.append(dependency)
        result[target] = list(dict.fromkeys(dependencies))
    return result


def resolve_closure(root: Path, requested: list[str], targets: list[str]) -> list[str]:
    unknown = [target for target in requested if target not in targets]
    if unknown:
        raise ValueError(f"postinstall intent references unknown targets: {unknown}")
    dependencies = dependency_map(root, targets)
    selected: set[str] = set()

    def include(target: str) -> None:
        if target in selected:
            return
        selected.add(target)
        for dependency in dependencies[target]:
            include(dependency)

    for target in requested:
        include(target)
    return [target for target in targets if target in selected]


def plan_digest(plan: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in plan.items() if key != "digest"}
    return hashlib.sha256(canonical_json(unsigned).encode("utf-8")).hexdigest()


def create_plan(args: argparse.Namespace) -> dict[str, Any]:
    root = repository_root()
    workflow_config = load_object(args.config, "postinstall workflow config")
    if workflow_config.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("postinstall workflow config has an unsupported schemaVersion")
    intents = workflow_config.get("intents")
    if not isinstance(intents, dict) or args.intent not in intents:
        raise ValueError(f"unknown postinstall intent: {args.intent}")
    recipe = intents[args.intent]
    if not isinstance(recipe, dict) or set(recipe) != {"installProfile", "requestedTargets"}:
        raise ValueError(f"postinstall intent {args.intent} has an invalid recipe")
    install_profile = recipe["installProfile"]
    if install_profile not in INSTALL_PROFILES:
        raise ValueError(f"postinstall intent {args.intent} has an invalid install profile")

    targets = target_catalog(root)
    requested_value = recipe["requestedTargets"]
    requested = list(targets) if requested_value == "all" else requested_value
    if not isinstance(requested, list) or any(not isinstance(item, str) or not item for item in requested):
        raise ValueError(f"postinstall intent {args.intent} has invalid requestedTargets")
    requested = list(dict.fromkeys(requested))
    resolved = resolve_closure(root, requested, targets)
    cache_tools = args.cache_tools == "true"
    partial = install_profile != "workspace"
    plan: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "id": f"{os.environ.get('GITHUB_WORKFLOW', 'workflow')}/{os.environ.get('GITHUB_JOB', 'job')}/{args.intent}",
        "intent": args.intent,
        "installProfile": install_profile,
        "cacheTools": cache_tools,
        "requestedTargets": requested,
        "resolvedTargets": resolved,
        "entries": {
            "dependencies": {
                "materializeDomToPptx": not partial,
                "probeNativeDependencies": not partial,
                "resolvedTargets": [],
                "concurrency": args.concurrency,
            },
            "build": {
                "materializeDomToPptx": False,
                "probeNativeDependencies": False,
                "resolvedTargets": resolved,
                "concurrency": args.concurrency,
            },
            "all": {
                "materializeDomToPptx": not partial,
                "probeNativeDependencies": not partial,
                "resolvedTargets": resolved,
                "concurrency": args.concurrency,
            },
        },
    }
    plan["digest"] = plan_digest(plan)
    return plan


def plan_command(args: argparse.Namespace) -> int:
    plan = create_plan(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    append_outputs({
        "path": str(args.output),
        "json": canonical_json(plan),
        "digest": plan["digest"],
        "install-profile": plan["installProfile"],
    })
    print(canonical_json(plan))
    return 0


def load_receipts(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    receipts: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("postinstall receipt line must be an object")
        receipts.append(value)
    return receipts


def consume_command(args: argparse.Namespace) -> int:
    plan = load_object(args.plan, "postinstall plan")
    if plan.get("schemaVersion") != SCHEMA_VERSION or plan.get("digest") != plan_digest(plan):
        raise ValueError("postinstall plan digest is invalid")
    receipts = load_receipts(args.receipts)
    for receipt in receipts:
        if receipt.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("postinstall receipt has an unsupported schemaVersion")
        if receipt.get("planId") != plan.get("id") or receipt.get("planDigest") != plan.get("digest"):
            raise ValueError("postinstall receipt does not belong to the frozen plan")
        if receipt.get("status") != "success":
            raise ValueError("postinstall receipt did not succeed")

    profile = plan["installProfile"]
    cache_tools = bool(plan["cacheTools"])
    expected_entries = ["build"] if profile != "workspace" else (["dependencies"] if cache_tools else ["all"])
    receipt_entries = {receipt.get("entry") for receipt in receipts}
    missing = [entry for entry in expected_entries if entry not in receipt_entries]
    if missing:
        raise ValueError(f"postinstall receipts are missing required entries: {missing}")

    build_receipt = next((receipt for receipt in receipts if receipt.get("entry") in {"build", "all"}), None)
    restored_targets: list[str] = []
    executed_targets: list[str] = []
    if cache_tools and args.tools_cache_hit == "true":
        restored_targets = list(plan["resolvedTargets"])
    else:
        if build_receipt is None:
            raise ValueError("postinstall build receipt is required when the tool closure was not restored")
        executed_targets = build_receipt.get("executedTargets", [])
        if executed_targets != plan["resolvedTargets"]:
            raise ValueError("postinstall executed targets differ from the frozen plan")

    result = {
        "schemaVersion": SCHEMA_VERSION,
        "planId": plan["id"],
        "planDigest": plan["digest"],
        "intent": plan["intent"],
        "installProfile": profile,
        "requiredTargets": plan["resolvedTargets"],
        "executedTargets": executed_targets,
        "restoredTargets": restored_targets,
        "status": "success",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    append_outputs({"json": canonical_json(result), "path": str(args.output)})
    print(canonical_json(result))
    return 0


def validate_command(args: argparse.Namespace) -> int:
    root = repository_root()
    config = load_object(args.config, "postinstall workflow config")
    intents = config.get("intents", {})
    if not isinstance(intents, dict) or not intents:
        raise ValueError("postinstall workflow config requires intents")
    for intent in intents:
        namespace = argparse.Namespace(
            cache_tools="false", concurrency=1, config=args.config, intent=intent,
        )
        create_plan(namespace)
    print(canonical_json({"schemaVersion": SCHEMA_VERSION, "intents": sorted(intents), "targets": target_catalog(root)}))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Produce and consume workflow postinstall plans.")
    parser.add_argument("--config", type=Path, default=repository_root() / ".github/config/postinstall.json")
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--intent", required=True)
    plan.add_argument("--cache-tools", choices=["true", "false"], default="false")
    plan.add_argument("--concurrency", type=int, default=1)
    plan.add_argument("--output", type=Path, required=True)
    consume = commands.add_parser("consume")
    consume.add_argument("--plan", type=Path, required=True)
    consume.add_argument("--receipts", type=Path, required=True)
    consume.add_argument("--tools-cache-hit", choices=["true", "false"], default="false")
    consume.add_argument("--output", type=Path, required=True)
    commands.add_parser("validate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "plan":
        if args.concurrency < 1:
            raise ValueError("postinstall concurrency must be positive")
        return plan_command(args)
    if args.command == "consume":
        return consume_command(args)
    return validate_command(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"postinstall plan error: {error}", file=os.sys.stderr)
        raise SystemExit(2)
