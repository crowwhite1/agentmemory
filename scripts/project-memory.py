#!/usr/bin/env python3
"""Opt-in per-Git-root AgentMemory launcher for a built local fork (POSIX)."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
HOME = Path.home()
CONTROL = HOME / ".agentmemory" / "projects"
REGISTRY = CONTROL / "registry.json"
DATA = CONTROL / "data"
LOCK = CONTROL / "llm.lock"


def project_root(cwd):
    result = subprocess.run(["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Run inside a Git project (or pass --project).")
    return str(Path(result.stdout.strip()).resolve())


@contextmanager
def registry():
    CONTROL.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (CONTROL / "registry.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else {}
        yield entries


def save(entries):
    with tempfile.NamedTemporaryFile("w", dir=CONTROL, delete=False) as handle:
        try:
            json.dump(entries, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(handle.name, REGISTRY)
        finally:
            if os.path.exists(handle.name):
                os.unlink(handle.name)


def ports(slot):
    port = 3111 + slot * 100
    return port, port + 2, port + 46023


def occupied(port):
    with socket.socket() as connection:
        connection.settimeout(0.3)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def data_dir(entry):
    slot = entry["instance"]
    return Path(entry["base"]) / ("instance-" + str(slot)) if slot else Path(entry["base"])


def runtime_file(entry):
    return (data_dir(entry) if entry["instance"] else HOME / ".agentmemory") / "engine-state.json"


def owned(entry):
    try:
        state = json.loads(runtime_file(entry).read_text())
        compose = data_dir(entry) / "compose" / "worker-compose.yaml"
        return (state["kind"] == "compose"
                and state["restPort"] == ports(entry["instance"])[0]
                and Path(state["file"]).resolve() == compose.resolve()
                and Path(state["stateDir"]).resolve() == (data_dir(entry) / "compose-state").resolve()
                and "AGENTMEMORY_LLM_LOCK_FILE" in compose.read_text()
                and str(LOCK) in compose.read_text())
    except (OSError, ValueError, KeyError, TypeError):
        return False


def ready(entry):
    if not owned(entry):
        return False
    try:
        with urllib.request.urlopen(url(entry) + "/agentmemory/livez", timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def url(entry):
    return "http://127.0.0.1:" + str(ports(entry["instance"])[0])


def allocate(entries, project, existing=None):
    if project in entries:
        if existing:
            raise RuntimeError("Project already registered; refusing to change its data directory.")
        return entries[project]
    if existing:
        # Existing state stays in place. Only canonical instance 0 can use
        # an arbitrary existing directory with the stock --instance flags.
        base = Path(existing).expanduser().resolve(strict=True)
        if not (base / "state_store.db").exists():
            raise RuntimeError("Selected directory has no state_store.db.")
        if any(e["instance"] == 0 for e in entries.values()) or any(map(occupied, ports(0))):
            raise RuntimeError("Instance 0 is already registered or running. Stop the old service first.")
        slot = 0
    else:
        legacy = Path(project) / "data"
        if (legacy / "state_store.db").exists() or (legacy / "iii-config.yaml").exists():
            raise RuntimeError("Existing project state detected. Register it explicitly with --existing-data-dir; no empty replacement created.")
        used = {e["instance"] for e in entries.values()}
        base = DATA
        slot = next((i for i in range(1, 51) if i not in used
                     and not (base / ("instance-" + str(i))).exists()
                     and not any(map(occupied, ports(i)))), None)
        if slot is None:
            raise RuntimeError("No free managed instance slots.")
    entry = {"instance": slot, "base": str(base)}
    target = data_dir(entry).resolve()
    for other in entries.values():
        other_dir = data_dir(other).resolve()
        if target == other_dir or target in other_dir.parents or other_dir in target.parents:
            raise RuntimeError("Overlapping project data directories are not allowed.")
    entries[project] = entry
    save(entries)
    return entry


def environment(entry):
    env = os.environ.copy()
    rest, viewer, engine = ports(entry["instance"])
    env.update({
        "AGENTMEMORY_URL": url(entry),
        "AGENTMEMORY_DATA_DIR": str(data_dir(entry)),
        "AGENTMEMORY_CAPTURE_SPOOL_DIR": str(data_dir(entry) / "capture-spool"),
        "AGENTMEMORY_FORCE_PROXY": "1",
        "AGENTMEMORY_STATE_BACKEND": "file",
        "AGENTMEMORY_LLM_SERIALIZE": "true",
        "AGENTMEMORY_LLM_LOCK_FILE": str(LOCK),
        "AGENTMEMORY_LLM_LOCK_PYTHON": sys.executable,
        "CLAUDE_PLUGIN_OPTION_AGENTMEMORY_URL": url(entry),
        "III_REST_PORT": str(rest),
        "III_VIEWER_PORT": str(viewer),
        "III_ENGINE_PORT": str(engine),
        "III_ENGINE_URL": "ws://127.0.0.1:" + str(engine),
        "III_URL": "ws://127.0.0.1:" + str(engine),
        "AGENTMEMORY_METRICS_PORT": str(rest + 6353),
    })
    return env


def cli(entry, command):
    node = shutil.which("node")
    if not node or not (ROOT / "dist" / "cli.mjs").is_file():
        raise RuntimeError("Build this checkout with npm ci && npm run build first.")
    env = environment(entry)
    # --data-dir is a base, not the final path, for nonzero --instance.
    subprocess.run([node, str(ROOT / "dist" / "cli.mjs"), command,
                    "--instance", str(entry["instance"]), "--data-dir", entry["base"]],
                   cwd=ROOT, env=env, check=True, stdin=subprocess.DEVNULL,
                   stdout=sys.stderr, timeout=300)


def start(entries, entry):
    # Never run a legacy :3111 worker alongside managed workers without a
    # shared lock. Do not kill or adopt an unknown process.
    if entry["instance"] and occupied(3111):
        canonical = next((e for e in entries.values() if not e["instance"]), None)
        if canonical is None or not owned(canonical):
            raise RuntimeError("Legacy :3111 service is running without the managed shared lock. Stop it cleanly first.")
    if ready(entry):
        return
    if any(map(occupied, ports(entry["instance"]))):
        raise RuntimeError("Instance ports are occupied but the managed instance is not ready. Inspect or stop it first.")
    cli(entry, "start")
    if not ready(entry):
        raise RuntimeError("Managed worker did not become ready; no Codex launch.")


def codex_command(entry, args):
    # The wrapper selects exactly one root. Do not allow Codex arguments to
    # silently change directories or override the selected MCP configuration.
    for arg in args:
        if arg in ("-C", "--cd", "-c", "--config", "--add-dir", "resume", "fork") or arg.startswith(("--cd=", "--config=", "--add-dir=", "-C", "-c")):
            raise RuntimeError("Project-changing/config overrides and resume/fork are not supported by this launcher.")
    hooks = Path(os.environ.get("CODEX_HOME", str(HOME / ".codex"))) / "hooks.json"
    if hooks.exists():
        payload = hooks.read_text()
        # Legacy proxy hooks may assign AGENTMEMORY_URL themselves, bypassing
        # the inherited project URL. Refuse instead of mixing memories.
        if "agentmemory-proxy" in payload.lower() or ("agentmemory" in payload.lower() and ("AGENTMEMORY_URL" in payload or ":3111" in payload or ":3112" in payload)):
            raise RuntimeError("Legacy/explicit AgentMemory hooks detected. Review and replace them with native endpoint-inheriting hooks before using this launcher.")
    node, codex = shutil.which("node"), shutil.which("codex")
    if not node or not codex:
        raise RuntimeError("Node.js and Codex CLI are required.")
    bridge = ROOT / "plugin" / "scripts" / "plugin-bridge.mjs"
    if not bridge.is_file():
        raise RuntimeError("Build the native plugin bridge first.")
    options = [
        "mcp_servers.agentmemory.command=" + json.dumps(node),
        "mcp_servers.agentmemory.args=" + json.dumps([str(bridge)]),
        "mcp_servers.agentmemory.env.AGENTMEMORY_URL=" + json.dumps(url(entry)),
        "mcp_servers.agentmemory.env.AGENTMEMORY_DATA_DIR=" + json.dumps(str(data_dir(entry))),
        "mcp_servers.agentmemory.env.AGENTMEMORY_FORCE_PROXY=\"1\"",
        "mcp_servers.agentmemory.startup_timeout_sec=60",
    ]
    command = [codex]
    for option in options:
        command.extend(["-c", option])
    return command + args


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=os.getcwd())
    parser.add_argument("--existing-data-dir", help="Register a verified, offline single-project legacy directory on instance 0")
    parser.add_argument("action", choices=["register", "start", "stop", "restart", "status", "list", "codex"])
    parser.add_argument("args", nargs=argparse.REMAINDER)
    opts = parser.parse_args()
    if opts.existing_data_dir and opts.action != "register":
        parser.error("--existing-data-dir is only valid with register")
    if opts.action != "codex" and opts.args:
        parser.error("Unexpected extra arguments")
    with registry() as entries:
        if opts.action == "list":
            for root, entry in sorted(entries.items()):
                print(json.dumps({"project": root, "data": str(data_dir(entry)), "instance": entry["instance"],
                                  "url": url(entry), "settings": "http://127.0.0.1:" + str(ports(entry["instance"])[1]) + "/settings",
                                  "ready": ready(entry)}, ensure_ascii=False))
            return
        root = project_root(opts.project)
        entry = entries.get(root)
        if opts.action == "register":
            entry = allocate(entries, root, opts.existing_data_dir)
        elif opts.action in ("start", "codex"):
            entry = entry or allocate(entries, root)
        elif entry is None:
            raise RuntimeError("Project is not registered.")
        if opts.action in ("stop", "restart"):
            if any(map(occupied, ports(entry["instance"]))) and not owned(entry):
                raise RuntimeError("Refusing to stop an unverified instance.")
            if runtime_file(entry).exists():
                cli(entry, "stop")
        if opts.action == "status":
            print(json.dumps({"project": root, "data": str(data_dir(entry)), "url": url(entry), "ready": ready(entry)}))
            if ready(entry):
                cli(entry, "status")
        elif opts.action in ("start", "restart", "codex"):
            if opts.action == "codex":
                args = opts.args[1:] if opts.args[:1] == ["--"] else opts.args
                command = codex_command(entry, args)
            start(entries, entry)
        if opts.action in ("register", "start", "restart"):
            print(json.dumps({"project": root, "data": str(data_dir(entry)), "url": url(entry)}))
    if opts.action == "codex":
        os.chdir(root)
        os.execvpe(command[0], command, environment(entry))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print("agentmemory projects: " + str(error), file=sys.stderr)
        sys.exit(1)
