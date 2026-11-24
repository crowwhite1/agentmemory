# Per-project AgentMemory (opt-in, macOS/Linux)
 
Each Git worktree root gets a separate managed instance, StateKV directory,
capture spool and compression queue. The registry is outside repositories in
`~/.agentmemory/projects/registry.json`. New projects use slots 1–50 and
`~/.agentmemory/projects/data/instance-N`. Instance 0 is reserved for explicit
registration of an existing verified single-project store. No databases are
merged, copied, deleted or automatically adopted.
 
Build the fork first (`npm install --legacy-peer-deps --no-audit --no-fund && npm run build`). Python 3 with POSIX fcntl is
required. From a project directory:
 
```sh
python3 ~/life/agentmemory/scripts/project-memory.py register
python3 ~/life/agentmemory/scripts/project-memory.py start
python3 ~/life/agentmemory/scripts/project-memory.py codex
python3 ~/life/agentmemory/scripts/project-memory.py status
python3 ~/life/agentmemory/scripts/project-memory.py stop
python3 ~/life/agentmemory/scripts/project-memory.py list
```
 
The Codex wrapper starts the selected instance on demand, overrides its MCP
endpoint for the current CLI invocation, and sets the inherited hook URL and
spool location. It does not edit global Codex config or replace the Codex
binary. Existing native hooks must inherit the environment; the wrapper rejects
recognizable legacy proxy / explicit URL hooks. Do not use plain Codex, Codex
Desktop, other capture plugins, or manually change the workspace of the
wrapped session until their routing has been independently verified. Project
settings are available at the viewer URL printed by `list`. Shared provider
settings come from the existing AgentMemory environment file.
 
## Existing Crowisp memory
 
Do not run the old one-command proxy migration as part of this change. In
particular, a directory named state_store.db is not a SQLite file and must not
be opened with SQLite's backup API. Determine the active state path using
runtime metadata, inspect which projects it actually contains, drain the old
queue, stop the legacy launchd job and managed engine cleanly, and make an
offline backup of the complete store before adopting it. Only register a
directory that has been verified to contain a single project's memory:
 
```sh
cd ~/life/crowisp
python3 ~/life/agentmemory/scripts/project-memory.py --existing-data-dir /verified/absolute/data/path register
python3 ~/life/agentmemory/scripts/project-memory.py start
```
 
The existing directory is left in place and assigned port 3111. The launcher
refuses to adopt a live or ambiguous endpoint. If the old store contains
multiple projects, do not register it as Crowisp; preserve the original and
plan a separately verified export/import. Stop old auto-restarting launchd
services before cutover. Other existing stores are not touched by this script.
 
## Shared local LLM
 
Each managed worker passes the same absolute
`AGENTMEMORY_LLM_LOCK_FILE` and Python path into its native worker environment.
The process-local serialized provider takes a host-wide POSIX advisory lock
before generation and releases it after completion or an exception. The
kernel releases it on helper exit, including parent termination. Do not
remove the lock file while workers are running. Waiting operations remain
in each project's own queue. This is not a central durable FIFO: cross-project
ordering is determined by OS lock scheduling, and the gate covers AgentMemory
generation calls, not embeddings or other applications using LM Studio. All
concurrent AgentMemory workers must opt in to the same lock.
 
## Verification and scope
 
Run `npm test` and verify on the target Mac with two unrelated Git roots,
including native hook capture and recall, distinct state directories and
ports, stop/restart, and non-overlapping LM Studio requests. The launcher provides CLI management. Managed Viewers also display the common project registry on the Settings page.

## Project-aware MCP and capture entrypoints

`project-memory.py --project /absolute/repo mcp` pins an explicit project for
CLI sessions. `project-memory.py mcp` without a project negotiates MCP
`roots/list` with a capable client (e.g. a Desktop host), accepts only local
Git workspace paths, and refuses ambiguous or absent roots. A workspace change
requires reconnecting. The launcher never guesses the workspace from the
MCP subprocess cwd. Native hook dispatch uses the event's cwd/workspace roots
and binds the session ID to its initial project; conflicts are rejected.
The global Codex config migration has not yet installed these entrypoints.
Validate actual Desktop roots support before relying on Desktop MCP tools.

## Unified project panel

Open Settings on any managed instance. The project panel shows registered
roots, state directory, disk usage, ports, service state and compression queue
counts. Start/stop/restart dispatches the existing controller (no shell command
interpolation). Only loopback, same-origin lifecycle requests are accepted.
Commands are acknowledged after the controller process spawns, not after
completion; refresh explicitly. Logs are in
`~/.agentmemory/projects/actions/instance-N.log`.
No periodic polling. The panel requires at least one running Viewer; if all
instances are stopped, start a project with the CLI or the macOS control app.
Settings edits target the shared .env rather than the generated Compose copy;
routing variables are protected and runtime changes require restart.

## Compression queue controls

The local Settings page exposes the running instance's queue, the most recent
200 failed attempts persisted in its StateKV, and a paginated list of historical
failed observations not represented by a queue job. Failure records contain
identity, timestamp, attempt number, safe error category and retry outcome,
never raw prompts or provider response bodies. Historical attempts before this
feature cannot be reconstructed; existing observation failure metadata is
shown separately. Recovered observations retain their recent failure history.

Single-item retry and retry of visible errors enqueue work and reset the queue
attempt budget, not the observation's historical attempt count. Already queued,
completed or source-less observations are not reprocessed. No direct LLM
requests are issued by the Viewer. Queue pages load on opening, explicit
refresh, pagination and after a user retry. Each other project's queue is
available from its own Viewer link; no cross-store access.

The shared settings catalog always exposes max attempts (default 2), recovery
scan interval (300000 ms), initial retry delay (15000 ms), and maximum retry
delay (300000 ms). Saving validates ranges. Restart the relevant workers to
apply values. The model and global generation lock remain unchanged.

## Parallel generation

The default is four concurrent compression jobs per project and four LLM requests across all managed projects. Set AGENTMEMORY_COMPRESSION_QUEUE_CONCURRENCY and AGENTMEMORY_LLM_MAX_CONCURRENT_REQUESTS in Settings (1–16). Restart every active project after changing the shared limit. The global file-backed semaphore covers compression, summarization and vision calls from managed providers; workers with different capacities cannot use slots simultaneously. The LM Studio model must itself support the chosen parallel-request limit. Set both values to 1 to restore serial behavior. The shared lock does not control unrelated LM Studio clients. Local queue completion immediately frees a slot; failure history updates are serialized independently of generation.
