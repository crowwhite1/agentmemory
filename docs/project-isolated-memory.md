# Per-project AgentMemory (opt-in, macOS/Linux)
 
Each Git worktree root gets a separate managed instance, StateKV directory,
capture spool and compression queue. The registry is outside repositories in
`~/.agentmemory/projects/registry.json`. New projects use slots 1–50 and
`~/.agentmemory/projects/data/instance-N`. Instance 0 is reserved for explicit
registration of an existing verified single-project store. No databases are
merged, copied, deleted or automatically adopted.
 
Build the fork first (`npm ci && npm run build`). Python 3 with POSIX fcntl is
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
ports, stop/restart, and non-overlapping LM Studio requests. The launcher
provides CLI management and links to per-instance settings; a unified viewer
and automatic Desktop/legacy migration are not implemented here.
