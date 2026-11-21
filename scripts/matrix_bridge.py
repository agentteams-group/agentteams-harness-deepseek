#!/usr/bin/env python3
"""Minimal Matrix channel loop for an AgentTeams-managed DSH worker."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import shutil
import subprocess
import threading
import tempfile
import time
import urllib.error
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from bridge_state import BridgeState
from runtime_env import desired_model, deepseek_base_url, worker_environment
from matrix_channel import (
    MatrixClient,
    matrix_events,
    matrix_transaction_id,
    text_events,
    visible_matrix_user_ids,
)

STOP = threading.Event()
try:
    from runtime_observability import event as trace_event
except ImportError:
    def trace_event(*args, **kwargs):
        pass  # Standalone packages can run without container logging.


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def runtime_section(path: Path, section: str) -> dict[str, str]:
    """Read scalar values from one top-level controller-generated YAML section."""
    values: dict[str, str] = {}
    active = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw == f"{section}:":
            active = True
            continue
        if active and raw and not raw.startswith(" "):
            break
        if not active or not raw.startswith("  ") or raw.startswith("    "):
            continue
        key, separator, value = raw.strip().partition(":")
        if separator:
            values[key] = value.strip().strip("'\"")
    return values


def runtime_matrix_context(runtime_path: Path, worker_name: str, matrix_domain: str) -> tuple[str, dict[str, str]]:
    member = runtime_section(runtime_path, "member")
    team = runtime_section(runtime_path, "team")
    own_user_id = member.get("matrixUserId") or f"@{worker_name}:{matrix_domain}"
    room_types: dict[str, str] = {}
    if member.get("personalRoomId"):
        room_types[member["personalRoomId"]] = "personal"
    if team.get("teamRoomId"):
        room_types[team["teamRoomId"]] = "team"
    return own_user_id, room_types


def runtime_agent_user_ids(runtime_path: Path) -> set[str]:
    """Read agent Matrix IDs from the controller-generated team.members list."""
    agent_roles = {"team_leader", "team-leader", "teamleader", "leader", "worker", "remote", "remote-member"}
    members: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    in_team = False
    members_indent: int | None = None
    item_indent: int | None = None

    for raw in runtime_path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        indent = len(raw) - len(raw.lstrip(" "))
        if raw == "team:":
            in_team = True
            continue
        if in_team and stripped and indent == 0:
            break
        if not in_team:
            continue
        if members_indent is None:
            if stripped == "members:":
                members_indent = indent
            continue

        if stripped.startswith("- ") and indent >= members_indent:
            if current is not None:
                members.append(current)
            current = {}
            item_indent = indent
            field = stripped[2:]
        elif current is not None and item_indent is not None and indent > item_indent:
            field = stripped
        else:
            if current is not None:
                members.append(current)
            break

        key, separator, value = field.partition(":")
        if separator:
            current[key.strip()] = value.strip().strip("'\"")
    else:
        if current is not None:
            members.append(current)

    return {
        member["matrixUserId"]
        for member in members
        if member.get("role", "").strip().lower().replace("_", "-") in agent_roles
        and member.get("matrixUserId")
    }


def source_agent_reply_user_id(event: dict[str, object], agent_user_ids: set[str], own_user_id: str) -> str:
    sender = str(event.get("sender") or "").strip()
    if sender != own_user_id and sender in agent_user_ids and event.get("auto_source_mention") is not True:
        return sender
    return ""


def manager_allowed_senders(runtime_path: Path, matrix_domain: str) -> set[str]:
    """Resolve the Controller-owned Manager allow-list without a YAML dependency."""
    allowed = {f"@{os.getenv('AGENTTEAMS_ADMIN_USER', 'admin')}:{matrix_domain}"}
    in_policy = False
    in_group = False
    for line in runtime_path.read_text(encoding="utf-8").splitlines():
        if line == "  channelPolicy:":
            in_policy = True
            continue
        if in_policy and line and not line.startswith("    "):
            break
        if not in_policy:
            continue
        if line.strip() == "groupAllowExtra:":
            in_group = True
            continue
        if in_group:
            value = line.strip()
            if not value.startswith("- "):
                break
            allowed.add(value[2:].strip().strip("'\""))
    return allowed


def reply_mention_user_ids(
    event: dict[str, object],
    text: str,
    agent_user_ids: set[str],
    own_user_id: str,
) -> list[str]:
    """Target the source Agent, plus any known Agent visibly named in the reply."""
    allowed = agent_user_ids - {own_user_id}
    mentioned = set(visible_matrix_user_ids(text, allowed))
    source_agent = source_agent_reply_user_id(event, agent_user_ids, own_user_id)
    if source_agent:
        mentioned.add(source_agent)
    return sorted(mentioned)


def safe_filename(value: str) -> str:
    leaf = value.replace("\\", "/").rsplit("/", 1)[-1].strip()
    leaf = re.sub(r"[\x00-\x1f<>:\"|?*]", "_", leaf)
    if leaf in ("", ".", ".."):
        leaf = "attachment.bin"
    return leaf[:180]


def workspace_subdirectory(workspace: Path, name: str, *, create: bool = False) -> tuple[Path, Path]:
    workspace_root = workspace.resolve()
    directory_path = workspace_root / name
    if create:
        directory_path.mkdir(parents=True, exist_ok=True)
    directory = directory_path.resolve()
    if not directory.is_relative_to(workspace_root):
        raise RuntimeError(f"Workspace {name} escapes the Workspace through a symbolic link")
    return workspace_root, directory


def materialize_attachment(
    event: dict[str, str],
    client: MatrixClient,
    workspace: Path,
    max_bytes: int,
) -> tuple[str, Path]:
    data, downloaded_type = client.download_media(event["mxc_url"], max_bytes)
    room_key = hashlib.sha256(event["room_id"].encode("utf-8")).hexdigest()[:16]
    event_key = hashlib.sha256(event["event_id"].encode("utf-8")).hexdigest()[:16]
    workspace_root, inbox = workspace_subdirectory(workspace, "inbox", create=True)
    destination = inbox / room_key / event_key / safe_filename(event.get("filename") or event["body"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    resolved = destination.resolve()
    if not resolved.is_relative_to(inbox) or not resolved.is_relative_to(workspace_root):
        raise RuntimeError("Matrix attachment path escapes the Workspace inbox")
    resolved.write_bytes(data)
    relative = resolved.relative_to(workspace_root).as_posix()
    mimetype = event.get("mimetype") or downloaded_type
    label = "图片" if event["kind"] == "image" else "文件"
    prompt = (
        f"Matrix 用户 {event['sender']} 发来一个{label}。"
        f"它已保存到 Workspace 相对路径 `{relative}`（类型 {mimetype}）。"
        "请读取这个文件并完成用户请求；需要回传的文件请写入 Workspace 的 `outbox/` 目录。"
    )
    return prompt, resolved


def snapshot_outbox(workspace: Path) -> dict[str, str]:
    outbox_path = workspace.resolve() / "outbox"
    if not outbox_path.exists():
        return {}
    _workspace_root, outbox = workspace_subdirectory(workspace, "outbox")
    snapshot: dict[str, str] = {}
    for path in sorted(outbox.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(outbox).as_posix()
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        snapshot[relative] = digest.hexdigest()
    return snapshot


def changed_outbox_files(workspace: Path, before: dict[str, str]) -> list[str]:
    after = snapshot_outbox(workspace)
    return sorted(relative for relative, digest in after.items() if before.get(relative) != digest)


def workspace_output_path(workspace: Path, relative: str) -> Path:
    workspace_root, outbox = workspace_subdirectory(workspace, "outbox")
    path = (outbox / Path(relative)).resolve()
    if not path.is_relative_to(outbox) or not path.is_relative_to(workspace_root):
        raise RuntimeError(f"Workspace output escapes outbox: {relative}")
    return path


def output_remote_path(worker_name: str, relative: str) -> str:
    prefix = required_env("AGENTTEAMS_STORAGE_PREFIX").rstrip("/")
    normalized = Path(relative).as_posix().lstrip("/")
    return f"{prefix}/agents/{worker_name}/workspace/outbox/{normalized}"


def sync_output_paths(worker_name: str, workspace: Path, relative_paths: list[str]) -> None:
    for relative in relative_paths:
        path = workspace_output_path(workspace, relative)
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Workspace output is unavailable: {relative}")
        mc("cp", str(path), output_remote_path(worker_name, relative))


def restore_output_paths(worker_name: str, workspace: Path, relative_paths: list[str]) -> None:
    for relative in relative_paths:
        path = workspace_output_path(workspace, relative)
        if path.is_file() and not path.is_symlink():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        mc("cp", output_remote_path(worker_name, relative), str(path))
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Persisted Workspace output could not be restored: {relative}")


def send_output_paths(
    client: MatrixClient,
    room_id: str,
    event_id: str,
    workspace: Path,
    relative_paths: list[str],
    mentioned_user_ids: list[str] | None = None,
    auto_source_mention: bool = False,
) -> list[Path]:
    sent: list[Path] = []
    for relative in sorted(relative_paths):
        path = workspace_output_path(workspace, relative)
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Workspace output is unavailable: {relative}")
        client.send_file(
            room_id,
            path,
            event_id,
            f"{event_id}:file:{relative}",
            mentioned_user_ids,
            auto_source_mention,
        )
        sent.append(path)
    return sent


def send_workspace_outputs(
    client: MatrixClient,
    room_id: str,
    event_id: str,
    workspace: Path,
    before: dict[str, str],
    mentioned_user_ids: list[str] | None = None,
    auto_source_mention: bool = False,
) -> list[Path]:
    return send_output_paths(
        client,
        room_id,
        event_id,
        workspace,
        changed_outbox_files(workspace, before),
        mentioned_user_ids,
        auto_source_mention,
    )


def mc(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["mc", *args], check=check, text=True, capture_output=True)


def push_runtime_state(worker_name: str, state_path: Path) -> None:
    prefix = required_env("AGENTTEAMS_STORAGE_PREFIX").rstrip("/")
    mc("cp", str(state_path), f"{prefix}/agents/{worker_name}/runtime/{state_path.name}")


def refresh_runtime_config(worker_name: str, runtime_path: Path) -> bool:
    prefix = required_env("AGENTTEAMS_STORAGE_PREFIX").rstrip("/")
    remote = f"{prefix}/agents/{worker_name}/runtime/{runtime_path.name}"
    temporary = runtime_path.with_suffix(runtime_path.suffix + ".remote")
    temporary.unlink(missing_ok=True)
    mc("cp", remote, str(temporary))
    if not temporary.exists() or temporary.stat().st_size == 0:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"controller runtime config is empty: {remote}")
    if runtime_path.exists() and temporary.read_bytes() == runtime_path.read_bytes():
        temporary.unlink()
        return False
    temporary.replace(runtime_path)
    return True


def sync_sessions(worker_name: str) -> None:
    dsh_home = Path(required_env("DSH_HOME"))
    sessions = dsh_home / "sessions"
    if not sessions.exists():
        return
    prefix = required_env("AGENTTEAMS_STORAGE_PREFIX").rstrip("/")
    mc("mirror", f"{sessions}/", f"{prefix}/agents/{worker_name}/.dsh/sessions/", "--overwrite")


def dsh_error_detail(stderr: str, returncode: int) -> str:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    for line in lines:
        if line.startswith("Error: dsh:") or line.startswith("dsh:"):
            return line
    for line in lines:
        if line.startswith(("Error:", "TypeError:", "SyntaxError:", "ReferenceError:")):
            return line
    useful = [line for line in lines if not line.startswith("Node.js v") and not line.startswith("command terminated")]
    return useful[-1] if useful else f"exit {returncode}"


def run_dsh(
    task: str,
    workspace: Path,
    timeout_seconds: int,
    *,
    session_id: str,
    resume: bool,
    event_id: str,
    attempt: int,
    poll_control=None,
    room_id: str = "",
    sender: str = "",
    source_event_ids: list[str] | None = None,
    identity: dict | None = None, source_key: str = "", attach_only: bool = False,
) -> str:
    environment = os.environ.copy()
    runtime_path = environment.get("TEAMHARNESS_RUNTIME_CONFIG")
    projection = worker_environment(Path(runtime_path), environment.get("AGENTTEAMS_WORKER_NAME", "")) if runtime_path else {}
    if projection:
        environment.update(projection)
    if runtime_path and "DEEPSEEK_BASE_URL" not in projection:
        model, gateway = desired_model(Path(runtime_path))
        if model:
            environment["TEAMHARNESS_DSH_MODEL"] = model
        environment["DEEPSEEK_BASE_URL"] = deepseek_base_url(
            environment.get("DEEPSEEK_BASE_URL", ""),
            environment.get("AGENTTEAMS_AI_GATEWAY_URL", ""), gateway,
        )
    environment.pop("AGENTTEAMS_WORKER_GATEWAY_KEY", None)
    environment.update(
        {
            "TEAMHARNESS_DSH_SESSION_ID": session_id,
            "TEAMHARNESS_DSH_RESUME": "true" if resume else "false",
            "TEAMHARNESS_MATRIX_EVENT_ID": event_id,
            "TEAMHARNESS_DSH_ATTEMPT": str(attempt),
            "TEAMHARNESS_MATRIX_ROOM_ID": room_id,
            "TEAMHARNESS_MATRIX_SENDER": sender,
            "TEAMHARNESS_SESSION_SOURCE_EVENT_IDS": json.dumps(source_event_ids or [event_id]),
        }
    )
    if identity:
        environment.update(TEAMHARNESS_EXECUTION_IDENTITY=json.dumps(identity), TEAMHARNESS_MATRIX_SOURCE_KEY=source_key,
            TEAMHARNESS_SOURCE_EVENT_ID=(source_event_ids or [""])[0], TEAMHARNESS_DSH_ATTACH_ONLY=str(attach_only).lower())
    trace_event("inference.begin", event_id=event_id, room_id=room_id, session_id=session_id, attempt=attempt, layer="agent_turn")
    try:
        return _execute_dsh(task, workspace, timeout_seconds, environment, poll_control, event_id, session_id)
    except (OSError, subprocess.SubprocessError, RuntimeError, TimeoutError, InterruptedError) as error:
        # TimeoutExpired and CalledProcessError include the task in their command.
        detail = f"Agent turn timed out after {timeout_seconds}s" if isinstance(error, subprocess.TimeoutExpired) else str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = f"Agent turn exited with code {error.returncode}"
        trace_event("inference.failed", event_id=event_id, room_id=room_id, session_id=session_id,
                    error_type=type(error).__name__, error=detail[:4096], layer="agent_turn")
        raise


class MissingNativeSession(RuntimeError):
    """The runner rejected a missing cache before admitting input or tools."""


def _execute_dsh(task, workspace, timeout_seconds, environment, poll_control, event_id, session_id):
    process = subprocess.Popen(
        ["agentteams-dsh", task],
        cwd=workspace,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout_seconds
    try:
        while True:
            try:
                stdout, stderr = process.communicate(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                if poll_control and poll_control():
                    raise InterruptedError("Direct conversation stopped")
                if STOP.is_set():
                    raise InterruptedError("Worker is shutting down")
                if time.monotonic() >= deadline:
                    raise TimeoutError("DeepSeek Harness task timed out")
    finally:
        if process.poll() is None:
            # Native DSH disposes its profile and persists the room session on
            # SIGTERM. Reap the owned process group before acknowledging stop.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for line in stderr.splitlines():
        if line.startswith('[agentteams-native-event] '):
            try:
                record = json.loads(line.partition('] ')[2])
                trace_event(record['event'], event_id=event_id, session_id=session_id, **record['fields'])
            except (ValueError, KeyError, TypeError):
                continue  # Diagnostic output must not invalidate the native result.
    trace_event("inference.end", event_id=event_id, session_id=session_id, exit_code=process.returncode,
                error=dsh_error_detail(stderr, process.returncode)[:4096] if process.returncode else None, layer="agent_turn")
    answer = stdout.strip()
    if process.returncode == 75:
        raise MissingNativeSession("DSH native session cache is missing")
    if process.returncode != 0:
        detail = dsh_error_detail(stderr, process.returncode)
        raise RuntimeError(f"DeepSeek Harness task failed: {detail}")
    if not answer:
        raise RuntimeError("DeepSeek Harness returned an empty answer")
    return answer


def native_session_digest(session_id):
    # DSH rc.2 uses one JSONL log beneath the session's encoded ID. Our
    # generated ASCII references use only literal, filename-safe characters.
    if not re.fullmatch(r"session-(?:task|message)-[0-9a-f]{32}", session_id):
        return None
    root = Path(required_env("DSH_HOME")) / "sessions"
    logs = [p for p in root.glob("*/" + session_id + "/session.jsonl*")
            if p.name in {"session.jsonl", "session.jsonl.zstd"} and p.is_file()]
    if len(logs) != 1:
        return None
    with logs[0].open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def publish_task_reply(client, recovery, task, team, own_user_id, text):
    from worker_matrix_delivery import confirm_bound
    from worker_matrix_raw import publish_raw_saved

    identity = task["execution"]
    task_id = task["task_id"]
    def bind(checkpoint):
        saved = recovery.checkpoint(task_id, team, checkpoint)["execution"]
        confirm_bound(saved, identity, "deepseek-harness", checkpoint)
    event_id = publish_raw_saved(client, task["room_id"], text, identity["checkpoint"], own_user_id, bind,
        content={"org.agentteams.progress_only": True}, legacy_transaction_id=matrix_transaction_id)
    return recovery.delivered(task_id, team, event_id)


def task_stopped(recovery, task_id, team, source):
    from task_recovery import RecoveryUnavailable
    try:
        task = recovery.current(task_id, team)
    except RecoveryUnavailable:
        return False
    if not task:
        return True
    current = task.get("execution") or {}
    return current.get("state") in {"cancelled", "released"} or any(
        current.get(k) != source[k] for k in ("runtime", "instance_id", "process_id", "generation"))


def recover_tasks(client, state, worker_name, workspace, timeout_seconds, own_user_id, admitted,
                  *, source_events=(), recovery=None, snapshot=None, on_scan=None):
    from task_recovery import Recovery, RecoveryConflict, enabled
    from worker_matrix_state import WorkerMatrix
    from worker_sessions import WorkerSessions
    if not enabled():
        return
    if recovery is None:
        recovery = Recovery(device_delivery=True)
        WorkerMatrix("deepseek-harness", recovery=recovery).start()
    sessions = WorkerSessions("deepseek-harness", recovery=recovery)
    snapshot = snapshot or recovery.discover()
    claims = []
    for entry in snapshot["tasks"]:
        task_id, team = entry["task"]["task_id"], entry["team_id"]
        try:
            claimed = recovery.claim(snapshot, entry)
        except RecoveryConflict:
            continue
        claims.append((task_id, team, claimed))
    if on_scan:
        on_scan()
    for task_id, team, claimed in claims:
        task = claimed["task"]
        if task["execution"]["state"] == "needs_verification":
            continue
        if (task["execution"]["state"] != "active" or task["execution"]["runtime"] != "deepseek-harness"
                or task["execution"]["instance_id"] != snapshot["instance_id"]
                or task["execution"]["process_id"] != recovery.process):
            continue
        cp = task["execution"].get("checkpoint") or {}
        if cp.get("delivery") == "pending":
            publish_task_reply(client, recovery, task, team, own_user_id, claimed["saved_result"])
            task = recovery.current(task_id, team)
            if task is None:
                continue
        admission = (team, task_id, task["execution"]["generation"])
        if task["status"] == "submitted":
            continue
        key = team + "/" + task_id
        work = {"kind": "task", "team_id": team, "task_id": task_id}
        view = sessions.load(work)
        if view["generation"] != admission[2] or view["checkpoint_digest"] != recovery.digest(cp or None):
            continue
        cached = (view.get("cache") or {}).get("native_ref", "")
        resume = sessions.usable(view, cached, native_session_digest(cached)) if cached else False
        session_id = cached if resume else "session-task-" + uuid.uuid4().hex
        source = next((event for event in source_events
            if event.get("room_id") == task["room_id"]
            and event.get("coordination_session", "").startswith("coordination-task:" + task_id + ":")), None)
        attach_only = admission in admitted
        source_key = (source or {}).get("source_key", "")
        if attach_only and not (source_key and resume):
            continue
        event_id = "recovery:" + key + ":" + str(admission[2])
        kwargs = {"session_id": session_id, "resume": resume, "event_id": event_id, "attempt": 1,
            "room_id": task["room_id"], "sender": source["sender"] if source else own_user_id,
            "source_event_ids": [source["event_id"]] if source else [],
            "poll_control": lambda: task_stopped(recovery, task_id, team, task["execution"]),
            "source_key": source_key, "attach_only": attach_only, "identity": {"team_id": team, "task_id": task_id,
                **{field: task["execution"][field] for field in ("generation", "instance_id", "process_id")}}}
        # Keep native file permissions scoped to this assigned Task, matching
        # the taskDirectory returned by TeamHarness ACK.
        tasks_root = (Path(os.getenv("TEAMHARNESS_SHARED_DIR") or workspace.parent / "shared") / "tasks").resolve()
        task_workspace = (tasks_root / task_id).resolve()
        if not task_workspace.is_relative_to(tasks_root) or task_workspace == tasks_root:
            raise ValueError("Task directory escapes the assigned tasks root")
        task_workspace.mkdir(parents=True, exist_ok=True)
        if attach_only:
            run_dsh("", task_workspace, timeout_seconds, **kwargs)
            sync_sessions(worker_name)
            digest = native_session_digest(session_id)
            if digest:
                sessions.remember(work, view, task["execution"], session_id, digest, int(time.time()) + 86400)
            continue
        text = recovery.resume_text({**task, "team_id": team, "spec": claimed["spec"]})
        # Reserve before execution. An unknown tool failure must not enter the
        # ordinary Matrix event retry loop or start another turn in this boot.
        admitted.add(admission)
        try:
            try:
                answer = run_dsh(text, task_workspace, timeout_seconds, **kwargs)
            except MissingNativeSession:
                if not resume:
                    raise
                session_id = "session-task-" + uuid.uuid4().hex
                kwargs.update(session_id=session_id, resume=False)
                answer = run_dsh(text, task_workspace, timeout_seconds, **kwargs)
            sync_sessions(worker_name)
            saved, answer = recovery.prepare_reply(task_id, team, answer)
        except Exception:
            recovery.interrupted(task_id, team)
            raise
        cp = saved["execution"]["checkpoint"]
        if cp.get("delivery") != "delivered":
            saved = publish_task_reply(client, recovery, {**task, "execution": saved["execution"]}, team, own_user_id, answer)
        digest = native_session_digest(session_id)
        if digest and task["status"] != "submitted":
            view = sessions.load(work)
            if view["checkpoint_digest"] == recovery.digest(saved["execution"]["checkpoint"]):
                sessions.remember(work, view, task["execution"], session_id, digest, int(time.time()) + 86400)


def managed_matrix_event(source, room_types, own, agents, transport):
    """Apply the projected sender policy before persisting actionable inputs."""
    from task_coordination import IgnoredNotification, notification

    room, raw = source["room_id"], source["input"]
    content, sender = raw.get("content") or {}, raw.get("sender")
    if not sender or raw.get("unsigned", {}).get("redacted_because"):
        return None
    if "org.agentteams.coordination" in content:
        try:
            packet = notification(content, room, sender, own)
        except IgnoredNotification:
            return None
        meta = packet["meta"]["teamharness_coordination"]
        if meta["kind"] == "task_assigned":
            return "task_notification", meta["task_id"], {"coordination_session": packet["session_id"], "body": packet["text"], "_task_protocol_meta": packet["meta"]}
        return "message", None, {"coordination_session": packet["session_id"], "body": packet["text"], "_task_protocol_meta": packet["meta"]}
    if room not in room_types:
        return None
    if content.get("org.agentteams.progress_only") or sender == own:
        return None
    personal = room_types[room] == "personal"
    policy = (transport.get("dm") or {}).get("policy") if personal else transport.get("groupPolicy")
    allow = (transport.get("dm") or {}).get("allowFrom", []) if personal else transport.get("groupAllowFrom", [])
    if policy == "disabled" or (policy and policy != "open" and sender not in allow and "*" not in allow):
        return None
    event = {**raw, "event_id": source["event_id"]}
    batch = {"rooms": {"join": {room: {"timeline": {"events": [event]}}}}}
    parsed = matrix_events(batch, room_types, own, agents)
    if not parsed:
        return None
    native = parsed[0]
    if "execution_control" in native or "answer" in native or re.sub(r"^(?:@\S+\s+)+", "", native["body"]).startswith("/agentteams-approval "):
        return "control", None, native
    return "message", None, native


def deliver_managed_message(client, matrix, claim, source, own, agents):
    from worker_matrix_delivery import confirm_bound
    from worker_matrix_raw import publish_raw_saved

    identity, text = claim["identity"], claim["saved_result"]
    content = {"m.relates_to": {"m.in_reply_to": {"event_id": source["event_id"]}}}
    relation = (claim["input"]["input"]["content"].get("m.relates_to") or {})
    if relation.get("rel_type") == "m.thread" and relation.get("event_id"):
        content["m.relates_to"].update(rel_type="m.thread", event_id=relation["event_id"])
    if source.get("coordination_session"):
        content["org.agentteams.progress_only"] = True
    else:
        mentions = reply_mention_user_ids(source, text, agents, own)
        if mentions:
            content["m.mentions"] = {"user_ids": mentions}
        if source_agent_reply_user_id(source, agents, own):
            content["com.agentteams.auto_source_mention"] = True
    def bind(checkpoint):
        saved = matrix.message_checkpoint(identity, checkpoint)
        confirm_bound(saved["execution"], identity, "deepseek-harness", checkpoint)
    event = publish_raw_saved(client, source["room_id"], text, claim["execution"]["checkpoint"],
                              own, bind, content=content, legacy_transaction_id=matrix_transaction_id)
    return matrix.message_delivered(identity, event)


def recover_message(client, matrix, sessions, source, own, agents, worker, workspace, timeout, *, admit, poll_control=None):
    from task_recovery import Recovery, RecoveryConflict
    from worker_matrix_raw import raw_room_history, require_unencrypted_room

    key = source["source_key"]
    claim = matrix.message_claim(key)
    mode, identity = claim["recovery"], claim["identity"]
    if mode == "deliver":
        return deliver_managed_message(client, matrix, claim, source, own, agents)
    if mode != "resume":
        return
    work = {"kind": "message", "event_key": key}
    view = sessions.load(work)
    if view["generation"] != identity["generation"] or view["checkpoint_digest"] != claim["checkpoint_digest"]:
        raise RecoveryConflict("Message checkpoint changed before session admission")
    cached = (view.get("cache") or {}).get("native_ref", "")
    reuse = bool(cached and sessions.usable(view, cached, native_session_digest(cached)))
    ref = cached if reuse else "session-message-" + uuid.uuid4().hex
    task = claim["resume_text"]
    if source["kind"] != "text":
        prompt, _ = materialize_attachment(source, client, workspace, int(os.getenv("AGENTTEAMS_MATRIX_ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024)))
        task += "\n" + prompt
    def new_prompt():
        history = raw_room_history(client, matrix, own, source["room_id"], source["event_id"], admit)
        return task + ("\nEarlier Matrix messages:\n" + json.dumps(history, ensure_ascii=False) if history else "")
    def stopped():
        from task_recovery import RecoveryUnavailable
        try:
            current = matrix._message_owned(identity)
        except RecoveryUnavailable:
            return False
        except RecoveryConflict:
            return True
        return current["execution"]["state"] in {"cancelled", "released"} or bool(poll_control and poll_control(identity))
    before = snapshot_outbox(workspace)
    kwargs = dict(session_id=ref, resume=reuse, identity=identity, source_key=key,
        room_id=source["room_id"], sender=source["sender"], source_event_ids=[source["event_id"]],
        event_id=f"recovery:{key}:{identity['generation']}:{claim['checkpoint_digest']}", attempt=1, poll_control=stopped)
    try:
        text = run_dsh(task if reuse else new_prompt(), workspace, timeout, **kwargs)
    except MissingNativeSession:
        if not reuse:
            raise
        ref = "session-message-" + uuid.uuid4().hex
        text = run_dsh(new_prompt(), workspace, timeout, **{**kwargs, "session_id":ref, "resume":False})
    matrix.message_current(identity)
    sync_sessions(worker)
    outputs = changed_outbox_files(workspace, before)
    if not outputs and text.strip() == "NO_REPLY":
        matrix.message_cancel(identity)
        return
    if outputs:
        account = client.request("GET", "/_matrix/client/v3/account/whoami")
        if account.get("user_id") != own or not account.get("device_id"):
            raise RecoveryConflict("Matrix attachment credential belongs to another Worker")
        room = source["room_id"]
        require_unencrypted_room(client, room)
        with tempfile.TemporaryDirectory() as directory:
            calls, files = [], []
            for relative in outputs:
                original = workspace_output_path(workspace, relative)
                copy = Path(directory) / str(len(files)) / original.name
                copy.parent.mkdir()
                shutil.copyfile(original, copy)
                with copy.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                calls.append({"id": relative, "name": "matrix.send_file", "arguments": {"room": room, "sha256": digest}})
                files.append(copy)
            operation = matrix.message_begin_tools(identity, calls, reply=text, output_bytes=(f.read_bytes() for f in files))
            def before_send():
                matrix.message_pending_tools(identity, operation)
                require_unencrypted_room(client, room)
            receipts = []
            for call, path in zip(calls, files):
                before_send()
                mc("cp", str(path), output_remote_path(worker, call["id"]))
                event = client.send_file(room, path, source["event_id"], key + ":file:" + call["id"], before_send=before_send)
                if not isinstance(event, str) or not event.startswith("$"):
                    raise RecoveryConflict("Matrix file delivery is unconfirmed")
                receipts.append({"id": call["id"], "content": {**call["arguments"], "event_id": event}})
            saved = matrix.message_finish_tools(identity, operation, receipts, deliver_result=True)
    else:
        saved = matrix.message_save_reply(identity, text)
    delivered = deliver_managed_message(client, matrix, saved, source, own, agents)
    digest = native_session_digest(ref)
    if digest:
        view = sessions.load(work)
        if view["checkpoint_digest"] == Recovery.digest(delivered["execution"]["checkpoint"]):
            sessions.remember(work, view, identity, ref, digest, int(time.time()) + 86400)


def direct_member(client, event, own_user_id, room_types, agent_user_ids):
    if room_types.get(event["room_id"]) != "personal" or event["sender"] in agent_user_ids:
        return False
    try:
        members = client.request("GET", "/_matrix/client/v3/rooms/" + urllib.parse.quote(event["room_id"], safe="") + "/joined_members")
        return set(members.get("joined", {})) == {own_user_id, event["sender"]}
    except Exception:
        return False


def execution_status(client, event, status, message_id=None):
    return client.send_content(event["room_id"], {
        "msgtype": "m.notice", "body": {
            "running": "正在执行", "stopping": "正在停止", "stopped": "已停止",
            "completed": "本轮已结束", "failed": "执行失败",
        }[status],
        "com.agentteams.execution": {"run_id": event["event_id"], "status": status,
            "capabilities": ["stop", "steer"], **({"message_id": message_id} if message_id else {})},
    }, f"{event['event_id']}:execution:{status}")


def poll_direct_control(client, since, active, state, own_user_id, room_types, agent_user_ids, allowed_senders):
    # Do not advance the durable cursor here: ordinary messages must still be
    # ingested by the outer loop after this native process has exited.
    payload = client.sync(since, 0)
    client.fill_timeline_gaps(payload, since, room_types)
    controls = []
    for event in matrix_events(payload, room_types, own_user_id, agent_user_ids, allowed_senders):
        control = event.get("execution_control")
        if (isinstance(control, dict) and control.get("action") in {"stop", "steer"}
                and control.get("agent_id") == own_user_id and control.get("run_id") == active["event_id"]
                and event["room_id"] == active["room_id"] and event["sender"] == active["sender"]
                and not state.is_completed(event["event_id"])
                and direct_member(client, event, own_user_id, room_types, agent_user_ids)):
            controls.append(event)
    if not controls:
        return False
    inputs = state.data["events"][active["event_id"]].get("direct_inputs", [active["body"]])
    input_ids = state.data["events"][active["event_id"]].get("direct_input_ids", [active["event_id"]])
    supplements = []
    for event in controls:
        if event["execution_control"]["action"] == "steer":
            supplements.append(event)
            inputs = [*inputs, event["body"]]
            input_ids = [*input_ids, event["event_id"]]
        state.mark_completed(event["event_id"], "")
    if supplements:
        pending = state.data["events"][supplements[-1]["event_id"]]
        pending.update(status="queued", direct_inputs=inputs, direct_input_ids=input_ids)
    state.save()
    execution_status(client, active, "stopping")
    return True


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self.send_response(404)
            self.end_headers()
            return
        body = b'{"ok":true,"runtime":"deepseek-harness"}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def serve_health() -> None:
    port = int(os.getenv("AGENTTEAMS_CONSOLE_PORT", "8088"))
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    server.timeout = 1
    while not STOP.is_set():
        server.handle_request()
    server.server_close()


def managed_rooms(client, payload, rooms, own, transport):
    """Discover authorized direct conversations in addition to projected rooms."""
    dm = transport.get("dm") or {}
    allowed = set(dm.get("allowFrom") or [])

    def admits(sender, personal=True):
        policy = dm.get("policy") if personal else transport.get("groupPolicy")
        senders = allowed if personal else set(transport.get("groupAllowFrom") or [])
        return policy != "disabled" and (policy == "open" or sender in senders or "*" in senders)

    for room, invite in payload.get("rooms", {}).get("invite", {}).items():
        direct = any(event.get("type") == "m.room.member" and event.get("state_key") == own
            and event.get("content", {}).get("membership") == "invite"
            and admits(event.get("sender"), event.get("content", {}).get("is_direct") is True)
            for event in invite.get("invite_state", {}).get("events", []))
        if room in rooms or direct:
            client.request("POST", "/_matrix/client/v3/join/" + urllib.parse.quote(room, safe=""), {})
    actual = client.request("GET", "/_matrix/client/v3/joined_rooms")["joined_rooms"]
    for room in actual:
        if room in rooms or dm.get("policy") == "disabled":
            continue
        members = set(client.request("GET", "/_matrix/client/v3/rooms/"
            + urllib.parse.quote(room, safe="") + "/joined_members").get("joined", {}))
        if own in members and len(members) == 2 and admits(next(iter(members - {own}))):
            rooms[room] = "personal"
    # Unknown joined rooms admit only receipt-verified coordination controls;
    # ordinary chat still requires a configured or verified direct room.
    return set(actual)


def run_managed_worker(client, worker, runtime_path, workspace, timeout, own, stop):
    import yaml
    from task_recovery import Recovery, RecoveryConflict
    from worker_handoff import recovery_scanned
    from worker_matrix_raw import RawWorkerSync
    from worker_matrix_state import WorkerMatrix, matrix_event_key
    from worker_sessions import WorkerSessions

    recovery = Recovery(device_delivery=True)
    matrix = WorkerMatrix("deepseek-harness", recovery=recovery)
    sessions = WorkerSessions("deepseek-harness", recovery=recovery)
    matrix.start()
    admitted = set()
    rooms, agents, transport = {}, set(), {}
    joined = set()

    def observe(payload):
        joined.clear()
        joined.update(managed_rooms(client, payload, rooms, own, transport))
        return joined

    def classify(room, raw):
        source = {"room_id": room, "event_id": raw["event_id"], "input": raw}
        native = managed_matrix_event(source, rooms, own, agents, transport)
        return native[:2] if native else None

    receiver = RawWorkerSync(matrix, client, own, classify, observe)
    def pending_sources(snapshot):
        sources = []
        for row in matrix.pending(snapshot):
            room = row["room_id"]
            if room not in joined or snapshot["state"]["rooms"].get(room, {}).get("gaps"):
                continue
            receiver.require_room(room)
            parsed = managed_matrix_event(row, rooms, own, agents, transport)
            if parsed is None:
                continue
            intent, task_id, event = parsed
            retained_coordination = (row["intent"] == "control" and intent == "message"
                and "org.agentteams.coordination" in row["input"].get("content", {}))
            if intent != row["intent"] and not retained_coordination:
                continue
            if intent == "task_notification" and (not task_id or row.get("work", {}).get("task_id") != task_id):
                continue
            receipt = row.get("native_commit") or {}
            start = receipt.get("start") or {}
            sources.append({**event, "room_id": room, "event_id": row["event_id"], "sender": row["input"]["sender"],
                "source_key": matrix_event_key(room, row["event_id"]), "kind": event.get("kind", "text"), "intent": intent,
                "native_committed": start.get("process_id") == recovery.process})
        return sources

    def direct_controls(active, identity):
        # Poll the same durable feed while a direct model/tool process is live.
        snapshot, _ = receiver.poll(0)
        for event in pending_sources(snapshot):
            control = event.get("execution_control") or {}
            if (event["intent"] != "control" or control.get("agent_id") != own
                    or control.get("run_id") != active["event_id"] or event["room_id"] != active["room_id"]
                    or event["sender"] != active["sender"] or not direct_member(client, event, own, rooms, agents)):
                continue
            if control.get("action") == "stop":
                matrix.message_cancel(identity)
                return True
            if control.get("action") == "steer":
                entry = matrix.message_current(identity)
                cp = dict(entry["execution"].get("checkpoint") or {})
                marker = "steer:" + event["source_key"]
                steps = cp.get("completed_steps") or []
                if marker not in steps:
                    cp.update(version=cp.get("version", 0) + 1, completed_steps=[*steps, marker],
                              remaining_steps=[*(cp.get("remaining_steps") or []), event["body"]])
                    matrix.message_checkpoint(identity, cp)
                    return True
        return False

    reported_ready = False

    def ready_after_scan():
        nonlocal reported_ready
        if reported_ready:
            return
        subprocess.run(["agt", "worker", "report-ready", "--name",
                        os.getenv("AGENTTEAMS_WORKER_CR_NAME", worker)], check=True)
        recovery_scanned()
        trace_event("runtime.ready", evidence="matrix_sync_and_task_scan")
        reported_ready = True

    while not stop.is_set():
        try:
            refresh_runtime_config(worker, runtime_path)
            record = yaml.safe_load(runtime_path.read_text())
            configured_own, configured_rooms = runtime_matrix_context(runtime_path, worker, required_env("AGENTTEAMS_MATRIX_DOMAIN"))
            if configured_own != own:
                raise RecoveryConflict("Matrix account changed during the current Worker start")
            tasks = recovery.discover()
            rooms.clear()
            rooms.update(configured_rooms)
            for entry in tasks["tasks"]:
                room = entry["task"].get("room_id")
                if room:
                    rooms.setdefault(room, "team")
            agents = runtime_agent_user_ids(runtime_path)
            transport = (record.get("matrix") or {}).get("transport") or {}
            try:
                snapshot, failures = receiver.poll(1000)
            except (ValueError, OSError, RuntimeError):
                # Matrix may be temporarily offline. Independently assigned Tasks
                # still progress, but readiness waits for a real Matrix scan.
                recover_tasks(client, None, worker, workspace, timeout, own, admitted, recovery=recovery, snapshot=tasks)
                raise
            for room, error in failures.items():
                trace_event("matrix.backfill.failed", room_id=room, error=str(error)[:1024])
            sources = pending_sources(snapshot)
            recover_tasks(client, None, worker, workspace, timeout, own, admitted, recovery=recovery, snapshot=tasks,
                          on_scan=ready_after_scan, source_events=[e for e in sources if e["intent"]=="task_notification" and not e["native_committed"]])
            for source in sources:
                if source["intent"] == "message":
                    try:
                        direct = direct_member(client, source, own, rooms, agents)
                        recover_message(client, matrix, sessions, source, own, agents, worker, workspace, timeout,
                            admit=lambda room, raw: classify(room, raw) == ("message", None),
                            poll_control=(lambda identity: direct_controls(source, identity)) if direct else None)
                    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
                        trace_event("inference.interrupted", event_id=source["event_id"], error=str(error)[:1024])
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
            trace_event("matrix.failed", error=str(error)[:1024])
            stop.wait(2)
    return 0


def main() -> int:
    worker_name = required_env("AGENTTEAMS_WORKER_NAME")
    runtime_path = Path(required_env("TEAMHARNESS_RUNTIME_CONFIG"))
    os.environ.update(worker_environment(runtime_path, worker_name))
    homeserver = required_env("AGENTTEAMS_MATRIX_URL")
    token = required_env("AGENTTEAMS_WORKER_MATRIX_TOKEN")
    workspace = Path(required_env("TEAMHARNESS_WORKSPACE"))
    workspace.mkdir(parents=True, exist_ok=True)
    matrix_domain = required_env("AGENTTEAMS_MATRIX_DOMAIN")
    own_user_id, room_types = runtime_matrix_context(runtime_path, worker_name, matrix_domain)
    agent_user_ids = runtime_agent_user_ids(runtime_path)
    from task_recovery import enabled
    if not room_types and not enabled():
        raise RuntimeError("runtime.yaml contains no personalRoomId or teamRoomId")
    client = MatrixClient(homeserver, token)
    threading.Thread(target=serve_health, name="health", daemon=True).start()
    if enabled():
        return run_managed_worker(client, worker_name, runtime_path, workspace,
            int(os.getenv("AGENTTEAMS_DSH_TASK_TIMEOUT_SECONDS", "3600")), own_user_id, STOP)
    state_path = runtime_path.parent / "matrix-bridge-state.json"
    state = BridgeState.load(state_path)
    legacy_cursor_path = runtime_path.parent / "matrix-next-batch"
    if state.next_batch is None and legacy_cursor_path.exists():
        state.next_batch = legacy_cursor_path.read_text(encoding="utf-8").strip()
    since = state.next_batch
    admitted_tasks = set()
    recover_tasks(client, state, worker_name, workspace,
        int(os.getenv("AGENTTEAMS_DSH_TASK_TIMEOUT_SECONDS", "3600")), own_user_id, admitted_tasks)

    # Process this first batch through the normal loop. A missing local cursor
    # must not discard pending Matrix input when changing Harnesses.
    initial = client.sync(since, 0)

    timeout_seconds = int(os.getenv("AGENTTEAMS_DSH_TASK_TIMEOUT_SECONDS", "3600"))
    attachment_max_bytes = int(os.getenv("AGENTTEAMS_MATRIX_ATTACHMENT_MAX_BYTES", str(25 * 1024 * 1024)))
    max_attempts = max(1, int(os.getenv("AGENTTEAMS_MATRIX_EVENT_MAX_ATTEMPTS", "3")))
    retry_base_seconds = max(1, int(os.getenv("AGENTTEAMS_MATRIX_RETRY_BASE_SECONDS", "2")))
    print(f"[agentteams-dsh-worker] ready worker={worker_name} rooms={len(room_types)}", flush=True)
    trace_event("runtime.ready", evidence="matrix_sync")
    if os.getenv("AGENTTEAMS_CONTROLLER_URL"):
        subprocess.run(["agt", "worker", "report-ready", "--name",
                        os.getenv("AGENTTEAMS_WORKER_CR_NAME", worker_name)], check=True)
    while not STOP.is_set():
        try:
            if refresh_runtime_config(worker_name, runtime_path):
                own_user_id, room_types = runtime_matrix_context(runtime_path, worker_name, matrix_domain)
                agent_user_ids = runtime_agent_user_ids(runtime_path)
                if not room_types:
                    raise RuntimeError("updated runtime.yaml contains no personalRoomId or teamRoomId")
                print(
                    f"[agentteams-dsh-worker] runtime config refreshed rooms={len(room_types)}",
                    flush=True,
                )
            payload = initial if initial is not None else client.sync(since, 30_000)
            initial = None
            allowed_senders = None
            if runtime_section(runtime_path, "member").get("role") == "manager":
                allowed_senders = manager_allowed_senders(runtime_path, matrix_domain)
                agent_user_ids = allowed_senders - {f"@{os.getenv('AGENTTEAMS_ADMIN_USER', 'admin')}:{matrix_domain}"}
                # Manager spans its admin DM and all joined member rooms.
                room_types.update({room: "team" for room in payload.get("rooms", {}).get("join", {}) if room not in room_types})
            client.fill_timeline_gaps(payload, since, room_types)
            events = matrix_events(payload, room_types, own_user_id, agent_user_ids, allowed_senders)
            recover_tasks(client, state, worker_name, workspace, timeout_seconds, own_user_id, admitted_tasks, source_events=events)
            batch_complete = True
            for event in events:
                if event.get("coordination_session", "").startswith("coordination-task:"):
                    from task_recovery import enabled
                    if enabled():
                        state.mark_completed(event["event_id"], "")
                        state.save()
                        continue
                # Consumed by the native interaction waiter while run_dsh was
                # blocked; stale controls must never start another model turn.
                if re.sub(r"^(?:@\S+\s+)+", "", str(event.get("body", "")).strip()).startswith("/agentteams-approval "):
                    continue
                if isinstance(event.get("answer"), dict) and event["answer"].get("confirmation_id"):
                    continue
                if state.is_completed(event["event_id"]):
                    continue
                control = event.get("execution_control")
                if control is not None and (not isinstance(control, dict) or control.get("action") != "steer" or control.get("agent_id") != own_user_id):
                    state.mark_completed(event["event_id"], "")
                    state.save()
                    continue
                session_id, resume = state.session_for(event.get("coordination_session", event["room_id"]))
                trace_event("message.received", room_id=event["room_id"], event_id=event["event_id"], sender=event["sender"])
                attempts = state.begin_event(event["event_id"], event["room_id"])
                state.save()
                push_runtime_state(worker_name, state_path)
                direct = direct_member(client, event, own_user_id, room_types, agent_user_ids)
                try:
                    cached_answer = state.answer_for(event["event_id"])
                    if cached_answer is None:
                        task = event["body"]
                        inputs = state.data["events"][event["event_id"]].get("direct_inputs")
                        if inputs:
                            task = "Continue the original request using all supplementary information. Preserve conversation context and earlier results.\n\n" + "\n\n".join(inputs)
                        if allowed_senders is not None:
                            task = f"Current Matrix room: {event['room_id']}\nSender: {event['sender']}\n\n{task}"
                        if event["kind"] != "text":
                            task, _saved_path = materialize_attachment(event, client, workspace, attachment_max_bytes)
                        outbox_before = state.outbox_before_for(event["event_id"])
                        if outbox_before is None:
                            outbox_before = snapshot_outbox(workspace)
                            state.mark_outbox_before(event["event_id"], outbox_before)
                            state.save()
                            push_runtime_state(worker_name, state_path)
                        if direct:
                            execution_status(client, event, "running")
                        answer = run_dsh(
                            task,
                            workspace,
                            timeout_seconds,
                            session_id=session_id,
                            resume=resume,
                            event_id=event["event_id"],
                            attempt=attempts,
                            poll_control=(lambda: poll_direct_control(client, since, event, state, own_user_id, room_types, agent_user_ids, allowed_senders)) if direct else None,
                            room_id=event["room_id"],
                            sender=event["sender"],
                            source_event_ids=state.data["events"][event["event_id"]].get("direct_input_ids", [event["event_id"]]),
                        )
                        sync_sessions(worker_name)
                        state.mark_session_ready(event.get("coordination_session", event["room_id"]))
                        output_paths = changed_outbox_files(workspace, outbox_before)
                        sync_output_paths(worker_name, workspace, output_paths)
                        state.mark_answer(event["event_id"], answer, output_paths)
                        state.save()
                        push_runtime_state(worker_name, state_path)
                    else:
                        answer, output_paths = cached_answer

                    restore_output_paths(worker_name, workspace, output_paths)
                    source_agent = source_agent_reply_user_id(event, agent_user_ids, own_user_id)
                    reply_mentions = reply_mention_user_ids(event, answer, agent_user_ids, own_user_id)
                    if event.get("coordination_session"):
                        reply_mentions, source_agent = [], ""
                    reply_event_id = client.send_text(
                        event["room_id"],
                        answer,
                        event["event_id"],
                        f"{event['event_id']}:reply",
                        reply_mentions,
                        bool(source_agent),
                        **({"progress_only": True} if event.get("coordination_session") else {}),
                    )
                    trace_event("message.sent", room_id=event["room_id"], event_id=event["event_id"], reply_event_id=reply_event_id)
                    send_output_paths(
                        client,
                        event["room_id"],
                        event["event_id"],
                        workspace,
                        output_paths,
                        [source_agent] if source_agent else [],
                        bool(source_agent),
                        **({"progress_only": True} if event.get("coordination_session") else {}),
                    )
                    state.mark_completed(event["event_id"], reply_event_id)
                    if direct:
                        execution_status(client, event, "completed", reply_event_id)
                    state.save()
                    push_runtime_state(worker_name, state_path)
                except InterruptedError:
                    sync_sessions(worker_name)
                    state.mark_session_ready(event.get("coordination_session", event["room_id"]))
                    state.mark_completed(event["event_id"], "")
                    state.save()
                    push_runtime_state(worker_name, state_path)
                    if direct and not STOP.is_set():
                        execution_status(client, event, "stopped")
                except Exception as error:
                    trace_event("turn.failed", room_id=event["room_id"], event_id=event["event_id"], error_type=type(error).__name__, error=str(error)[:4096])
                    if direct:
                        execution_status(client, event, "failed")
                    state.mark_failure(event["event_id"], str(error))
                    state.save()
                    push_runtime_state(worker_name, state_path)
                    if state.should_retry(event["event_id"], max_attempts):
                        delay = min(30, retry_base_seconds * (2 ** (attempts - 1)))
                        print(
                            f"[agentteams-dsh-worker] event retry event={event['event_id']} "
                            f"attempt={attempts}/{max_attempts} delay={delay}s error={error}",
                            flush=True,
                        )
                        batch_complete = False
                        STOP.wait(delay)
                        break
                    failure = f"DeepSeek Harness 任务执行失败（已重试 {attempts} 次）：{error}"
                    source_agent = source_agent_reply_user_id(event, agent_user_ids, own_user_id)
                    failure_event_id = client.send_text(
                        event["room_id"],
                        failure,
                        event["event_id"],
                        f"{event['event_id']}:failure",
                        reply_mention_user_ids(event, failure, agent_user_ids, own_user_id),
                        bool(source_agent),
                        **({"progress_only": True} if event.get("coordination_session") else {}),
                    )
                    state.mark_completed(event["event_id"], failure_event_id)
                    state.save()
                    push_runtime_state(worker_name, state_path)
            if not batch_complete:
                continue
            next_batch = str(payload.get("next_batch") or "")
            if next_batch and next_batch != since:
                since = next_batch
                state.next_batch = since
                state.save()
                push_runtime_state(worker_name, state_path)
        except (
            urllib.error.URLError,
            TimeoutError,
            OSError,
            RuntimeError,
            ValueError,
            json.JSONDecodeError,
            subprocess.SubprocessError,
        ) as error:
            trace_event("matrix.failed", error_type=type(error).__name__, error=str(error)[:4096])
            print(f"[agentteams-dsh-worker] channel error: {error}", flush=True)
            STOP.wait(2)
    return 0


def stop(_signum: int, _frame: object) -> None:
    STOP.set()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    raise SystemExit(main())
