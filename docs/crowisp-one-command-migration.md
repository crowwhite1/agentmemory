# Project-aware one-command migration (macOS)

Close all active Codex sessions before migration. From the user's Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/crowwhite1/agentmemory/main/scripts/bootstrap-crowisp.command | zsh
```

The installer builds the fork and runs its tests before modifying services.
It verifies the active Compose StateKV path from runtime metadata; a missing
configured path is an error even if a different store exists. It scans the
legacy sessions and memories with authenticated pagination and adopts only an
unambiguously single-project store. Mixed or unscoped legacy data is never
silently assigned to a project. No stores are merged.

The old delivery queue must be drained. The installer freezes old proxy intake,
stops the old managed worker, and makes an offline StateKV directory snapshot
(or SQLite backup for a file) plus final proxy queue backup. It registers the
verified project on instance 0, enables the shared generation lock, starts
the fork, and verifies the integrated compression queue and settings page.
It preserves the selected model, auto compression, unrelated Codex settings
and hooks, and restores backed-up configuration and services on failure when
possible. Unassigned stores and the old proxy checkout remain in place; no
automatic deletion or movement of other databases. The old proxy service is
retired, not the data.

The global Codex MCP command now negotiates workspace roots. Hosts that do not
advertise MCP roots require explicit project routing via the CLI wrapper:
`python3 ~/life/agentmemory/scripts/project-memory.py codex` from a Git project.
Native hooks route by verified workspace paths and session IDs. Review/trust
the changed hooks in Codex, and restart existing sessions. Verify actual Codex
Desktop roots support before using MCP tools there; no fallback store is used.
Project instances start on demand; the migrated instance is started for
verification but is not set to launch automatically at login.

Read-only investigation:
`python3 ~/life/agentmemory/scripts/migrate-from-proxy.py --inspect`.
If the configured store is missing or contains mixed memory, investigate
before proceeding. A separate verified export/import is needed to split
historical mixed stores. Backups remain under
`~/.agentmemory/migration-backups`.

For project management see [project-isolated-memory.md](project-isolated-memory.md).

The installer creates `~/.local/bin/agentmemory-projects` and, when Codex CLI
is on PATH, `~/.local/bin/codex-memory`. Existing regular bash/zsh startup
files receive an idempotent project-aware `codex` shell function; existing
custom aliases/functions and symlinked startup files are not overwritten.
Open a new terminal to activate it. Outside a Git project and for non-session
commands (login, help, version), Codex launches normally; no project is guessed.
Workspace-changing flags and resume/fork remain unsupported by the pinned
CLI launcher. The Control.app starts the migrated Viewer on demand.

Read-only preflight without a full npm build (updates the fork checkout only):

```sh
curl -fsSL https://raw.githubusercontent.com/crowwhite1/agentmemory/main/scripts/bootstrap-crowisp.command | zsh -s -- --inspect
```
