# AgentMemory + agentmemory-proxy integration plan

This branch is stage P1 of the Crowisp AgentMemory integration. The existing production install
continues using the original npm AgentMemory release and external Python proxy until a staged
migration has passed tests.

## Contract

- Keep `AGENTMEMORY_AUTO_COMPRESS=true`. The configured text-only model is
  `qwen3-4b-instruct-2507-mlx`; never silently switch models.
- Keep **original** image bytes and Base64 references in observation storage. Text-only Qwen
  receives *metadata* about attachments, not an instruction to visually interpret them.
- Use the existing iii-engine `StateKV` for compression jobs. Do not embed a second
  SQLite copy of the same observation.
- Index captured observations immediately and independently of LLM processing.
- Avoid rapid availability/health polling. Queue wakeups are event-driven, and only retry
  deadlines and slow recovery scans create timers.

## Integration stages

1. **P0 — prompt hardening:** prevent binary images from being reproduced in XML and
   reject truncated `finish_reason=length` LLM responses without deleting source data.
2. **P1 — queue:** persist jobs in `mem:compression:queue`, enqueue after capture,
   process with a single compression worker, retry with backoff and a limited budget,
   recover pending jobs after restart. Expose `GET /agentmemory/compression/queue`.
3. **P2 — settings page:** use the existing viewer at `http://127.0.0.1:3113/settings`
   to read documented config and update `~/.agentmemory/.env` atomically. No timed
   refresh loops and no exposure of stored secrets; restart needed to apply settings.
4. **P3 — shared LLM scheduler:** serialize compression *and* session summary, reflection
   and backfill jobs through the same scheduler; provider request cancellation, fair
   priority, breaker/backoff and error provenance. Change manual recovery to schedule
   jobs rather than blocking waiting for an LLM completion.
5. **P4 — migration:** integrate the old proxy dashboard and CLI, installer and service
   registration. Replace npm `@latest` with a pinned built fork. Redirect Codex to the
   native AgentMemory endpoint only after the old SQLite write queue is drained.

## Recovery and rollback

- Never treat the historical `mem::compress` failure count as a count of distinct lost observations.
- Historical failed observations are left alone until an explicit controlled backfill.
- The queue's `exhausted` job records are retained for diagnosis and explicit retry reset;
  its retry budget defaults to two attempts.
- Make a backup of iii-engine StateKV and the old proxy `queue.db` before any migration.
- Never point a second AgentMemory process at the same live state store during smoke tests.
- Switch back to the original npm-based AgentMemory and old proxy services on rollback;
  preserve both databases.
- `git merge` or force-installing this branch is *not* a deployment plan. Run
  `npm run build`, `npm run skills:gen`, `npm run docs:sync`,
  `npm run skills:check`, `npm test`, plus macOS LM Studio smoke tests.

## Known limitations of P1

- Existing manual compression-retry and summary recovery can still call
  `mem::compress` synchronously; P3 must migrate them to avoid secondary LLM bursts.
- This queue handles observations only; it does not yet replace all of the Python proxy.
- The initial queued store is a native StateKV scope; storage persistence timing follows
  the iii-engine StateKV backend guarantees, not the external proxy's SQLite fsync rules.
- GitHub Actions must be enabled on the new fork before PR checks can run.
