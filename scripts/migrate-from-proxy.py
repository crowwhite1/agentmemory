#!/usr/bin/env python3
"""Conservative, reversible macOS migration from agentmemory-proxy.

Run through scripts/migrate-from-proxy.command. Never erase memory or queue data.
"""
from __future__ import annotations

import json
import os
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import tomllib
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
DOMAIN = f"gui/{os.getuid()}"
PROXY_LABEL = "com.crowwhite.agentmemory-proxy"
MEMORY_LABEL = "com.crowwhite.agentmemory-managed"
LMSTUDIO_LABEL = "com.crowwhite.lmstudio-managed"
LAUNCH_DIR = HOME / "Library" / "LaunchAgents"
PROXY_PLIST = LAUNCH_DIR / f"{PROXY_LABEL}.plist"
MEMORY_PLIST = LAUNCH_DIR / f"{MEMORY_LABEL}.plist"
LMSTUDIO_PLIST = LAUNCH_DIR / f"{LMSTUDIO_LABEL}.plist"
ENV_PATH = Path(os.getenv("AGENTMEMORY_ENV_FILE") or HOME / ".agentmemory" / ".env")
CODEX_HOME = Path(os.getenv("CODEX_HOME") or HOME / ".codex")
CODEX_TOML = CODEX_HOME / "config.toml"
CODEX_HOOKS = CODEX_HOME / "hooks.json"
OLD_APP = HOME / "Applications" / "AgentMemory Control.app"
BACKUP_ROOT = HOME / ".agentmemory" / "migration-backups"
LOG_DIR = HOME / "Library" / "Logs" / "agentmemory"
LEGACY_URL = "http://127.0.0.1:3112"
MEMORY_URL = "http://127.0.0.1:3111"


class MigrationError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[agentmemory-migrate] {message}", flush=True)


def run(*args: str | Path, check: bool = True, timeout: int = 90,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(x) for x in args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, env=env)


def get_json(url: str, timeout: int = 7) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise MigrationError(f"Unexpected response from {url}")
    return result


def env_values(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in text.splitlines():
        hit = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$", line)
        if hit:
            value = hit.group(2).strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            found[hit.group(1)] = value
    return found


def update_env(text: str, values: dict[str, str]) -> str:
    seen: set[str] = set()
    lines: list[str] = []
    for line in text.splitlines():
        hit = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=", line)
        if hit and hit.group(1) in values:
            key = hit.group(1)
            if key not in seen:
                lines.append(f"{key}={values[key]}")
                seen.add(key)
        else:
            lines.append(line)
    for key, value in values.items():
        if key not in seen:
            lines.append(f"{key}={value}")
    return "\n".join(lines).rstrip("\n") + "\n"


def update_codex_toml(text: str, npx: str) -> str:
    parsed = tomllib.loads(text) if text.strip() else {}
    if re.search(r"(?m)^\\s*\\[\\[mcp_servers\\.agentmemory", text):
        raise MigrationError("Unsupported Codex AgentMemory array-of-tables; leaving config unchanged")
    servers = parsed.get("mcp_servers", {})
    existing = servers.get("agentmemory", {}) if isinstance(servers, dict) else {}
    if not isinstance(existing, dict):
        raise MigrationError("Invalid Codex AgentMemory config; leaving unchanged")
    extras = existing.get("env", {})
    if not isinstance(extras, dict):
        raise MigrationError("Invalid AgentMemory MCP environment")
    env = {k: v for k, v in extras.items()
           if isinstance(k, str) and isinstance(v, str)
           and k not in ("AGENTMEMORY_URL", "AGENTMEMORY_FORCE_PROXY")}
    env.update({"AGENTMEMORY_URL": MEMORY_URL, "AGENTMEMORY_FORCE_PROXY": "1"})
    kept: list[str] = []
    for part in re.split(r"(?m)(?=^\\[+[^\\n]+\\]+\\s*$)", text):
        hdr = re.match(r"\\s*\\[([^]]+)\\]", part)
        if hdr and (hdr.group(1).strip() == "mcp_servers.agentmemory" or
                    hdr.group(1).strip().startswith("mcp_servers.agentmemory.")):
            continue
        kept.append(part)
    prefix = "".join(kept).rstrip() + "\\n\\n"
    lines = [
        "[mcp_servers.agentmemory]",
        f"command = {json.dumps(npx)}",
        'args = ["-y", "@agentmemory/mcp"]',
    ]
    # Preserve existing AgentMemory-specific settings, except obsolete routing.
    for key, value in existing.items():
        if key in ("command", "args", "env"):
            continue
        if re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_-]*", key) and isinstance(value, (str, bool, int)):
            encoded = json.dumps(value).lower() if isinstance(value, bool) else json.dumps(value)
            lines.append(f"{key} = {encoded}")
    lines.extend(["", "[mcp_servers.agentmemory.env]"])
    lines.extend(f"{key} = {json.dumps(value)}" for key, value in env.items())
    updated = prefix + "\\n".join(lines) + "\\n"
    tomllib.loads(updated)
    return updated


def update_hooks(text: str) -> str:
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise MigrationError("Codex hooks.json must be a JSON object")
    def transform(value: object) -> object:
        if isinstance(value, list):
            return [transform(item) for item in value]
        if isinstance(value, dict):
            return {key: transform(item) for key, item in value.items()}
        if isinstance(value, str) and "agentmemory" in value.lower():
            return value.replace(LEGACY_URL, MEMORY_URL).replace(
                "http://localhost:3112", MEMORY_URL
            )
        return value
    return json.dumps(transform(payload), indent=2, ensure_ascii=False) + "\n"


def launch_loaded(label: str) -> bool:
    return run("launchctl", "print", f"{DOMAIN}/{label}", check=False).returncode == 0


def bootstrap(label: str, plist: Path) -> None:
    if not launch_loaded(label):
        result = run("launchctl", "bootstrap", DOMAIN, plist, check=False)
        if result.returncode:
            raise MigrationError(f"Failed to start {label}: {result.stderr.strip()}")


def bootout(label: str, plist: Path) -> None:
    if launch_loaded(label):
        result = run("launchctl", "bootout", DOMAIN, plist, check=False)
        if result.returncode:
            raise MigrationError(f"Failed to stop {label}: {result.stderr.strip()}")


def write_atomic(path: Path, payload: str | bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    target = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        with open(target, "xb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(payload.encode("utf8") if isinstance(payload, str) else payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(target, path)
    finally:
        if target.exists():
            target.unlink()


def state_databases() -> list[Path]:
    env = env_values(ENV_PATH.read_text() if ENV_PATH.exists() else "")
    roots: list[Path] = [
        HOME / "Library" / "Application Support" / "agentmemory",
        HOME / ".agentmemory",
        HOME / "life" / "agentmemory" / "data",
        HOME / "life" / "agentmemory-proxy" / "data",
    ]
    if env.get("AGENTMEMORY_DATA_DIR"):
        roots.insert(0, Path(env["AGENTMEMORY_DATA_DIR"]).expanduser())
    paths: set[Path] = set()
    for root in roots:
        for candidate in [root / "state_store.db", root / "data" / "state_store.db"]:
            if candidate.is_file():
                paths.add(candidate.resolve())
    return sorted(paths)


def prior_data_directory(proxy_root: Path, values: dict[str, str]) -> Path:
    explicit = values.get("AGENTMEMORY_DATA_DIR")
    if explicit:
        candidate = Path(explicit).expanduser()
        return (candidate if candidate.is_absolute() else proxy_root / candidate).resolve()
    legacy = (proxy_root / "data").resolve()
    if (legacy / "state_store.db").is_file() or (legacy / "iii-config.yaml").is_file():
        return legacy
    return (HOME / "Library" / "Application Support" / "agentmemory").resolve()


def under_path(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def snapshot_sqlite(source: Path, backup: Path) -> None:
    backup.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=20) as src:
        with sqlite3.connect(backup, timeout=20) as dest:
            src.backup(dest)
    backup.chmod(0o600)


def retry_failed_proxy_writes_once() -> None:
    """Retry old failed *delivery* rows once before considering a cutover."""
    status = get_json(f"{LEGACY_URL}/proxy/status")
    if status.get("failed", 0) <= 0:
        return
    if status.get("processing", 0) or status.get("pending", 0):
        raise MigrationError("Wait for the old write queue to drain before retrying failed entries")
    log(f"Retrying {status['failed']} failed proxy deliveries once before migration")
    req = urllib.request.Request(f"{LEGACY_URL}/proxy/retry-all", method="POST")
    with urllib.request.urlopen(req, timeout=15):
        pass
    until = time.monotonic() + 120
    while time.monotonic() < until:
        state = get_json(f"{LEGACY_URL}/proxy/status")
        if all(state.get(key) == 0 for key in ("pending", "processing", "failed")):
            return
        if state.get("failed", 0) > 0 and not state.get("processing", 0):
            break
        time.sleep(2)
    raise MigrationError("Some legacy delivery rows still fail. Resolve them in the old dashboard; no services have been stopped.")


def verify_model_available(configured_model: str) -> None:
    try:
        with urllib.request.urlopen("http://127.0.0.1:1234/v1/models", timeout=8) as res:
            models = json.load(res)
    except (OSError, ValueError) as exc:
        raise MigrationError("LM Studio local server at :1234 is unavailable") from exc
    ids = [item.get("id") for item in models.get("data", []) if isinstance(item, dict)]
    if configured_model not in ids:
        raise MigrationError(f"Configured model {configured_model!r} is not listed by LM Studio; refusing to switch models.")


def check_old_proxy() -> dict:
    status = get_json(f"{LEGACY_URL}/proxy/status")
    if any(status.get(k) != 0 for k in ("pending", "processing", "failed")):
        raise MigrationError(
            "Old queue is not empty; handle queued and failed writes in the old dashboard first. "
            f"pending={status.get('pending')} processing={status.get('processing')} "
            f"failed={status.get('failed')}"
        )
    llm = status.get("llm") or {}
    if llm.get("active", 0) or llm.get("pending", 0):
        raise MigrationError("LLM still has active or waiting requests; stop agents and retry")
    return status


def check_queue_file(path: Path) -> None:
    if not path.is_file():
        return
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        tables = {row[0] for row in conn.execute(
            "select name from sqlite_master where type='table'"
        )}
        if "queue" not in tables:
            raise MigrationError("Unknown legacy queue database schema")
        undelivered = conn.execute(
            "select count(*) from queue where state in ('pending','processing','failed')"
        ).fetchone()[0]
        if undelivered:
            raise MigrationError(f"Legacy database still contains {undelivered} undelivered entries")


def wait_ready(timeout: int = 90) -> None:
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            get_json(f"{MEMORY_URL}/agentmemory/livez", timeout=2)
            return
        except (OSError, ValueError, MigrationError):
            time.sleep(2)
    raise MigrationError("New AgentMemory did not become ready on port 3111")


def wait_old_worker_stopped(timeout: int = 25) -> None:
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            get_json(f"{MEMORY_URL}/agentmemory/livez", timeout=2)
        except (OSError, ValueError):
            return
        time.sleep(1)
    raise MigrationError("Old AgentMemory is still answering on port 3111 after stop; refusing to switch")


def verify_native_compression_queue() -> None:
    config = env_values(ENV_PATH.read_text() if ENV_PATH.is_file() else "")
    token = config.get("AGENTMEMORY_SECRET", "")
    if not token:
        generated = HOME / ".agentmemory" / "secret"
        if generated.is_file():
            token = generated.read_text().strip()
    if not token:
        raise MigrationError("Cannot verify new authenticated compression queue; no local AgentMemory secret")
    req = urllib.request.Request(
        f"{MEMORY_URL}/agentmemory/compression/queue",
        headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        status = json.load(response)
    if not isinstance(status, dict) or not all(k in status for k in ("pending", "running", "exhausted")):
        raise MigrationError("New AgentMemory does not expose the integrated compression queue; rolling back")


def native_plist(node: str) -> bytes:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return plistlib.dumps({
        "Label": MEMORY_LABEL,
        "ProgramArguments": [node, str(ROOT / "dist" / "cli.mjs")],
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {
            "HOME": str(HOME),
            "PATH": os.pathsep.join([str(Path(node).parent), "/opt/homebrew/bin",
                                     "/usr/local/bin", "/usr/bin", "/bin"]),
        },
        # The CLI launches supervised iii Compose workers and then returns.
        "RunAtLoad": True,
        "KeepAlive": False,
        "StandardOutPath": str(LOG_DIR / "agentmemory.out.log"),
        "StandardErrorPath": str(LOG_DIR / "agentmemory.err.log"),
    })


def migrate() -> int:
    if sys.platform != "darwin":
        raise MigrationError("Migration is macOS-only")
    if not (ROOT / ".git").exists() or not (ROOT / "dist" / "cli.mjs").is_file():
        raise MigrationError("Run from a built checkout of the AgentMemory fork")
    if not PROXY_PLIST.is_file() or not MEMORY_PLIST.is_file():
        raise MigrationError("Managed proxy or memory LaunchAgent not found; will not alter unknown setup")
    node, npx = shutil.which("node"), shutil.which("npx")
    if not node or not npx:
        raise MigrationError("Node.js and npm are required")
    retry_failed_proxy_writes_once()
    status = check_old_proxy()
    configured_model = env_values(ENV_PATH.read_text() if ENV_PATH.exists() else "").get("OPENAI_MODEL", "")
    if not configured_model:
        raise MigrationError("No OPENAI_MODEL is configured; refusing to choose a replacement")
    verify_model_available(configured_model)
    log("Old proxy queue is drained and the configured LM Studio model is available")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    backup_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    tracked = [ENV_PATH, CODEX_TOML, CODEX_HOOKS, PROXY_PLIST,
               MEMORY_PLIST, LMSTUDIO_PLIST]
    existed: list[bool] = []
    for idx, path in enumerate(tracked):
        existed.append(path.is_file())
        if path.is_file():
            shutil.copy2(path, backup_dir / f"file-{idx}")
            (backup_dir / f"file-{idx}").chmod(0o600)
    env_text = ENV_PATH.read_text() if ENV_PATH.is_file() else ""
    env = env_values(env_text)
    if env.get("AGENTMEMORY_STATE_BACKEND") == "redis":
        raise MigrationError("Redis backend needs a separate Redis snapshot; no changes made")
    for idx, path in enumerate(state_databases()):
        snapshot_sqlite(path, backup_dir / f"state-{idx}.sqlite")
    old_service = plistlib.loads(PROXY_PLIST.read_bytes())
    proxy_root = Path(old_service.get("WorkingDirectory", str(HOME / "life" / "agentmemory-proxy")))
    previous_data = prior_data_directory(proxy_root, env)
    # If the old state lives under the proxy checkout, move a consistent copy
    # out of that checkout *after stopping the old engine* and before new start.
    relocate_data = under_path(previous_data, proxy_root.resolve())
    next_data = ((HOME / "Library" / "Application Support" / "agentmemory").resolve()
                 if relocate_data else previous_data)
    if relocate_data and next_data.exists() and any(next_data.iterdir()):
        raise MigrationError(
            f"Cannot merge state directories {previous_data} and {next_data}; "
            "the target is not empty. No service has been changed."
        )
    if previous_data.is_dir():
        state_file = previous_data / "state_store.db"
        if state_file.is_file():
            snapshot_sqlite(state_file, backup_dir / "active-previous-state.sqlite")
    proxy_env_path = proxy_root / ".env"
    proxy_env = env_values(proxy_env_path.read_text() if proxy_env_path.is_file() else "")
    queue_path = Path(proxy_env.get("QUEUE_DB_PATH") or "queue.db").expanduser()
    if not queue_path.is_absolute():
        queue_path = proxy_root / queue_path
    if not queue_path.is_file():
        raise MigrationError(f"Legacy queue SQLite file not found at {queue_path}; no changes made")
    snapshot_sqlite(queue_path, backup_dir / "proxy-queue.sqlite")
    check_queue_file(queue_path)
    was_loaded = {
        "proxy": launch_loaded(PROXY_LABEL),
        "memory": launch_loaded(MEMORY_LABEL),
        "lmstudio": launch_loaded(LMSTUDIO_LABEL),
    }
    (backup_dir / "manifest.json").write_text(json.dumps({
        "tracked": [str(path) for path in tracked],
        "existing": [str(path) for path, yes in zip(tracked, existed) if yes],
        "queue_path": str(queue_path), "proxy_root": str(proxy_root),
        "previous_data_dir": str(previous_data), "new_data_dir": str(next_data),
        "loaded": was_loaded,
    }, indent=2) + "\n")
    log(f"All configuration and databases backed up: {backup_dir}")
    legacy_cli = HOME / ".local" / "bin" / "agentmemory-proxy"
    legacy_cli_target = os.readlink(legacy_cli) if legacy_cli.is_symlink() else None
    retired_checkout = backup_dir / "agentmemory-proxy-retired"
    retired_app = backup_dir / "AgentMemory Control.app"
    changed = False
    try:
        if not env.get("OPENAI_MODEL"):
            raise MigrationError("OPENAI_MODEL is missing; refusing to replace your Qwen model")
        values = {"OPENAI_BASE_URL": "http://127.0.0.1:1234/v1",
                  "AGENTMEMORY_AUTO_COMPRESS": "true",
                  "AGENTMEMORY_DATA_DIR": str(next_data)}
        if not env.get("AGENTMEMORY_LLM_PROVIDER"):
            values["AGENTMEMORY_LLM_PROVIDER"] = "openai"
        new_env = update_env(env_text, values)
        new_codex = update_codex_toml(
            CODEX_TOML.read_text() if CODEX_TOML.is_file() else "", npx
        )
        new_hooks = update_hooks(CODEX_HOOKS.read_text()) if CODEX_HOOKS.is_file() else None
        check_old_proxy()
        # Stop with the LEGACY environment still intact. The CLI uses
        # AGENTMEMORY_DATA_DIR to find Compose ownership metadata; replacing
        # it before stopping makes the old engine undiscoverable.
        changed = True
        bootout(MEMORY_LABEL, MEMORY_PLIST)
        legacy_env = os.environ.copy()
        legacy_env["AGENTMEMORY_DATA_DIR"] = str(previous_data)
        stopped = run(node, ROOT / "dist" / "cli.mjs", "stop", check=False,
                      timeout=45, env=legacy_env)
        if stopped.returncode:
            raise MigrationError("Could not stop old iii worker cleanly: " + stopped.stderr[-700:])
        wait_old_worker_stopped()
        write_atomic(ENV_PATH, new_env)
        write_atomic(CODEX_TOML, new_codex)
        if new_hooks is not None:
            write_atomic(CODEX_HOOKS, new_hooks)
        if relocate_data:
            if not previous_data.is_dir():
                raise MigrationError(f"Previous AgentMemory data directory disappeared: {previous_data}")
            shutil.copytree(previous_data, next_data, dirs_exist_ok=True)
            log(f"Copied existing memory state into permanent directory {next_data}")
        write_atomic(MEMORY_PLIST, native_plist(node), mode=0o644)
        bootstrap(MEMORY_LABEL, MEMORY_PLIST)
        wait_ready()
        verify_native_compression_queue()
        # Migrate the dependent LM Studio LaunchAgent before moving the proxy checkout.
        if LMSTUDIO_PLIST.is_file():
            old_lmstudio = plistlib.loads(LMSTUDIO_PLIST.read_bytes())
            argv = old_lmstudio.get("ProgramArguments", [])
            if any("agentmemory-proxy" in str(x) for x in argv):
                if was_loaded["lmstudio"]:
                    bootout(LMSTUDIO_LABEL, LMSTUDIO_PLIST)
                old_lmstudio["ProgramArguments"] = [
                    "/bin/zsh", str(ROOT / "scripts" / "start-lmstudio.command")
                ]
                old_lmstudio["WorkingDirectory"] = str(ROOT)
                write_atomic(LMSTUDIO_PLIST, plistlib.dumps(old_lmstudio), mode=0o644)
                if was_loaded["lmstudio"]:
                    bootstrap(LMSTUDIO_LABEL, LMSTUDIO_PLIST)
        # The new service is verified. Disable and retire old proxy.
        bootout(PROXY_LABEL, PROXY_PLIST)
        check_queue_file(queue_path)
        PROXY_PLIST.unlink()
        if legacy_cli.is_symlink() and str(proxy_root) in str(legacy_cli.resolve()):
            legacy_cli.unlink()
        if OLD_APP.exists():
            shutil.move(str(OLD_APP), str(backup_dir / "AgentMemory Control.app"))
        if shutil.which("osacompile"):
            shortcut = run("osacompile", "-o", OLD_APP, "-e",
                           'open location "http://127.0.0.1:3113/settings"',
                           check=False, timeout=30)
            if shortcut.returncode:
                log("Optional macOS control shortcut unavailable; browser settings still work")
        user_bin = HOME / ".local" / "bin"
        user_bin.mkdir(parents=True, exist_ok=True)
        cli_path = user_bin / "agentmemory"
        if not cli_path.exists() and not cli_path.is_symlink():
            wrapper = "#!/bin/zsh\nexec " + json.dumps(node) + " " + json.dumps(
                str(ROOT / "dist" / "cli.mjs")
            ) + ' "$@"\n'
            write_atomic(cli_path, wrapper, mode=0o755)
            log(f"Native agentmemory CLI installed: {cli_path}")
        else:
            log("Existing agentmemory CLI was left unchanged; no commands overwritten")
        expected = (HOME / "life" / "agentmemory-proxy").resolve()
        if proxy_root.resolve() == expected and (proxy_root / "pyproject.toml").is_file():
            shutil.move(str(proxy_root), str(retired_checkout))
            log(f"Old proxy repository retired to archive: {retired_checkout}")
        else:
            log(f"Unrecognized proxy checkout left unchanged: {proxy_root}")
        log("SUCCESS: old proxy service removed, fork active, Codex routes directly to :3111")
        log("No memory or queue data deleted; backups remain for rollback")
        log("Restart active Codex sessions so they reload the new MCP endpoint")
        log("Settings: http://127.0.0.1:3113/settings")
        return 0
    except BaseException:
        if changed:
            log("Migration interrupted; restoring previous configuration and services")
            # Restore legacy executable locations BEFORE relaunching launchd.
            # A failure after moving the checkout must never strand rollback.
            try:
                if retired_checkout.exists() and not proxy_root.exists():
                    shutil.move(str(retired_checkout), str(proxy_root))
                if retired_app.exists() and not OLD_APP.exists():
                    shutil.move(str(retired_app), str(OLD_APP))
                if legacy_cli_target and not legacy_cli.exists() and not legacy_cli.is_symlink():
                    legacy_cli.parent.mkdir(parents=True, exist_ok=True)
                    legacy_cli.symlink_to(legacy_cli_target)
            except OSError as exc:
                log(f"WARNING: legacy executable restore incomplete: {exc}")
            try:
                bootout(MEMORY_LABEL, MEMORY_PLIST)
                run(node, ROOT / "dist" / "cli.mjs", "stop", check=False, timeout=40)
            except Exception:
                pass
            for idx, path in enumerate(tracked):
                backup = backup_dir / f"file-{idx}"
                if existed[idx] and backup.is_file():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(backup, path)
                elif not existed[idx] and path.exists():
                    path.unlink()
            try:
                if was_loaded["memory"]:
                    bootstrap(MEMORY_LABEL, MEMORY_PLIST)
                if was_loaded["proxy"]:
                    bootstrap(PROXY_LABEL, PROXY_PLIST)
                if was_loaded["lmstudio"]:
                    bootstrap(LMSTUDIO_LABEL, LMSTUDIO_PLIST)
            except Exception as exc:
                log(f"WARNING: service restore incomplete: {exc}")
                log(f"Recover manually using {backup_dir}")
        raise


def main() -> int:
    try:
        return migrate()
    except (MigrationError, OSError, ValueError, subprocess.SubprocessError, sqlite3.Error) as exc:
        log(f"ABORTED: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
