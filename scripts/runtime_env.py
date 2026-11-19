#!/usr/bin/env python3
"""Resolve the small environment differences between AgentTeams and DSH."""

from __future__ import annotations

import os
from pathlib import Path
import sys


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def desired_model(path: Path) -> tuple[str, str]:
    """Read Controller-generated desired.model.{model,gatewayUrl}."""
    model = ""
    gateway_url = ""
    in_desired = False
    in_model = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw == "desired:":
            in_desired = True
            in_model = False
            continue
        if in_desired and raw and not raw.startswith(" "):
            break
        if not in_desired:
            continue
        if raw == "  model:":
            in_model = True
            continue
        if in_model and raw.startswith("  ") and not raw.startswith("    "):
            in_model = False
        if not in_model or not raw.startswith("    "):
            continue
        key, separator, value = raw.strip().partition(":")
        if not separator:
            continue
        if key == "model":
            model = _unquote(value)
        elif key == "gatewayUrl":
            gateway_url = _unquote(value)
    return model, gateway_url


def worker_environment(path, worker):
    """Resolve a managed Worker's native Matrix and model bindings at startup."""
    if not os.getenv("AGENTTEAMS_CONTROLLER_URL") or os.getenv("AGENTTEAMS_AGENT_ROLE") == "manager":
        return {}
    import yaml
    from worker_runtime_config import project

    record = yaml.safe_load(path.read_text())
    if record.get("member", {}).get("role") == "manager" or not record.get("matrix", {}).get("transport"):
        return {}  # Installed Controllers predating the shared transport projection.
    native_model = {"models": {"providers": {"deepseek": {"models": [
        {"id": os.getenv("TEAMHARNESS_DSH_MODEL", "deepseek-v4-flash")}],
        "apiKey": os.getenv("DEEPSEEK_API_KEY", ""), "baseUrl": os.getenv("DEEPSEEK_BASE_URL", "")}}}}
    config = project(record, "deepseek-harness", worker, native_model)
    matrix = config["channels"]["matrix"]
    if str(matrix.get("encryption", False)).lower() in {"true", "1"}:
        raise ValueError("DeepSeek Harness does not support Matrix E2EE")
    result = {"AGENTTEAMS_MATRIX_URL": matrix["homeserver"], "AGENTTEAMS_WORKER_MATRIX_TOKEN": matrix["accessToken"],
              "AGENTTEAMS_MATRIX_USER_ID": matrix["userId"]}
    if record.get("desired", {}).get("model"):
        provider = config["models"]["providers"]["agentteams-gateway"]
        result.update(TEAMHARNESS_DSH_MODEL=provider["models"][0]["id"], DEEPSEEK_BASE_URL=provider["baseUrl"],
                      DEEPSEEK_API_KEY=provider["apiKey"])
    return result


def deepseek_base_url(explicit_url: str, agentteams_gateway_url: str, runtime_gateway_url: str = "") -> str:
    """Return the DSH chat-completions base without duplicating path segments."""
    explicit = explicit_url.strip().rstrip("/")
    if explicit:
        return explicit
    gateway = (runtime_gateway_url.strip() or agentteams_gateway_url.strip()).rstrip("/")
    if not gateway or gateway.endswith("/v1"):
        return gateway
    return f"{gateway}/v1"


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "model":
        runtime_path = Path(sys.argv[2])
        fallback = sys.argv[3] if len(sys.argv) > 3 else ""
        model, _ = desired_model(runtime_path)
        print(model or fallback)
    elif command == "base-url":
        explicit = sys.argv[2] if len(sys.argv) > 2 else ""
        gateway = sys.argv[3] if len(sys.argv) > 3 else ""
        runtime_path = Path(sys.argv[4]) if len(sys.argv) > 4 else None
        runtime_gateway = desired_model(runtime_path)[1] if runtime_path is not None else ""
        print(deepseek_base_url(explicit, gateway, runtime_gateway))
    else:
        raise SystemExit("usage: runtime_env.py model RUNTIME_YAML [FALLBACK] | base-url EXPLICIT_URL GATEWAY_URL [RUNTIME_YAML]")
