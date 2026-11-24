# One-command Crowisp AgentMemory migration (macOS)

**Paused:** the legacy single-store cutover is disabled until project-aware migration is ready. The following describes the previous installer, not an instruction to run it. For read-only discovery use `python3 scripts/migrate-from-proxy.py --inspect`. A directory named `state_store.db` is an offline directory snapshot, not a SQLite database.

From the user's Mac, with the previous managed AgentMemory Proxy stack installed:

```bash
curl -fsSL https://raw.githubusercontent.com/crowwhite1/agentmemory/main/scripts/bootstrap-crowisp.command | zsh
```

The bootstrap checks out/pulls this fork under `~/life/agentmemory` without overwriting local changes. It builds and runs tests **before** modifying running services. The migration then:

1. Refuses to proceed if the old SQLite write queue contains pending, processing or failed deliveries, or if LLM requests are active; no records are dropped.
2. Makes private backups of AgentMemory StateKV SQLite, proxy queue and existing Codex, LaunchAgent and .env files under `~/.agentmemory/migration-backups/YYYYMMDD-HHMMSS`.
3. Preserves `OPENAI_MODEL`, existing LM Studio models, project memories, capture hooks and `AGENTMEMORY_AUTO_COMPRESS=true`.
4. Updates only AgentMemory's local LLM base URL from proxy gateway `:3114` to direct LM Studio `:1234`, then rewires only the AgentMemory Codex MCP and hooks from `:3112` to `:3111`.
5. Stops old managed AgentMemory cleanly; starts the locally built fork with the same StateKV data. Checks that the new server is reachable before stopping the proxy.
6. Migrates the LM Studio LaunchAgent to a script within this fork, removes the old proxy LaunchAgent and shortcut, and archives the old checkout (including queue database) instead of deleting the backup.
7. Restores backed-up configs and services on a failed switchover where possible. The installer **does not silently force migration through a failed preflight**.

After success, restart any open Codex sessions to reload MCP. Settings appear at `http://127.0.0.1:3113/settings`; native REST is at `http://127.0.0.1:3111`.

This installer supports only the specific launchd setup previously installed by `agentmemory-proxy`. Unknown system configurations are not modified. There is no repeated 3-second health polling; health checks run during installation and when explicitly requested.

**Do not** delete `~/.agentmemory/migration-backups` until the fork has been running correctly for several days. Historical `mem::compress` error counts cannot be reset by migration. Replaying old failed observations is a separate controlled operation.

### Local verification

```bash
python3 scripts/test-proxy-migration.py
npm test
```

This preflight intentionally does **not** overwrite a custom `OPENAI_MODEL`, download a different model, erase old `~/.agentmemory`, or delete SQLite queues. A nonzero exit code should be investigated before retrying. The old dashboard at `http://127.0.0.1:3112/dashboard` is still the place to resolve undelivered rows.

### Important limitations

- The old Python proxy has been retired but its backed-up data is retained in the archive.
- This does **not** automatically switch unrelated agent apps other than Codex.
- Active Codex sessions cannot reload their MCP config without a user restart.
- The integrated compression queue currently handles automatic observation compression. Full consolidation and manual recovery scheduling are tracked separately.
