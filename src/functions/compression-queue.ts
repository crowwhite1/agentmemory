import type { IIIClient } from "iii-sdk";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { observationRevision, needsCompression, compressionRaw, type StoredObservation } from "./compression-state.js";
import type { Session, CompressionQueueJob, CompressionQueueStatus } from "../types.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { readCompressionQueueSettings } from "./compression-queue-config.js";

type CompressionResult = { success?: boolean; skipped?: boolean; retryable?: boolean; error?: string };
type CompressionIdentity = { sessionId: string; observationId: string };

const JOB_BATCH = 64;

const HISTORY_LIMIT = 200;
const JOB_PAGE_SIZE = 100;
const LEGACY_PAGE_SIZE = 50;
const ARCHIVE_LIMIT = 200;
type ArchiveReason = "already_complete" | "legacy_no_compression_state";
type ArchivedJob = CompressionQueueJob & { archivedAt: number; reason: ArchiveReason };
type Failure = CompressionIdentity & { at: number; attempt: number; error: string; outcome: "retry_scheduled" | "exhausted" | "not_retryable" };

const safeErrors = new Set(["compression_failed", "parse_failed", "validation_failed", "source_unavailable",
  "dispatch_failed", "compression_timeout", "provider_failure", "queue_processing_failed",
  "invalid_raw_observation", "invalid_observation_identity"]);
function safeError(value: unknown): string {
  return typeof value === "string" && safeErrors.has(value) ? value : "provider_failure";
}

function readLegacyCursor(cursor?: string): [string, string] | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 32768) throw new Error("Invalid legacy cursor");
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== "string" || typeof decoded[1] !== "string") throw new Error();
    return [decoded[0], decoded[1]];
  } catch { throw new Error("Invalid legacy cursor"); }
}

function validIdentity(value: unknown): value is CompressionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<CompressionIdentity>;
  return [row.sessionId, row.observationId].every(x => typeof x === "string" && x.length > 0 && x.length <= 8192);
}

export function compressionQueueKey(sessionId: string, observationId: string): string {
  return fingerprintId("compression-job", JSON.stringify([sessionId, observationId]));
}

export function registerCompressionQueue(sdk: IIIClient, kv: StateKV): {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
  status(): Promise<CompressionQueueStatus>;
  inspect(cursor?: string, offset?: number): Promise<unknown>;
  retry(input: unknown): Promise<unknown>;
} {
  let stopped = false;
  let started = false;
  let pumping = false;
  const active = new Set<string>();
  let wakePending = false;
  let completed = 0;
  let failures = 0;
  let lastError: string | undefined;
  const settings = readCompressionQueueSettings();
  const { backfillMs, maxAttempts, retryBaseMs, retryMaxMs, concurrency } = settings;
  let backfillAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function enqueue(identity: CompressionIdentity): Promise<boolean> {
    if (!identity?.sessionId || !identity?.observationId) return false;
    const stored = await kv.get<StoredObservation>(
      KV.observations(identity.sessionId), identity.observationId,
    );
    if (!stored || !needsCompression(stored) || !compressionRaw(stored)) return false;
    const id = compressionQueueKey(identity.sessionId, identity.observationId);
    const added = await withKeyedLock(`compression-queue:${id}`, async () => {
      const existing = await kv.get<CompressionQueueJob>(KV.compressionQueue, id);
      if (existing) return false;
      const now = Date.now();
      const job: CompressionQueueJob = {
        id, sessionId: identity.sessionId, observationId: identity.observationId,
        enqueuedAt: now, dueAt: now, attempts: 0, status: "pending",
      };
      await kv.set(KV.compressionQueue, id, job);
      return true;
    });
    if (added) wake();
    return added;
  }

  function schedule(ms: number): void {
    if (stopped || !started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, Math.max(0, ms));
    timer.unref();
  }

  function wake(): void {
    if (stopped || !started) return;
    if (pumping) { wakePending = true; return; }
    if (active.size < concurrency) schedule(0);
  }

  async function recoverFromObservations(): Promise<void> {
    const sessions = await kv.list<Session>(KV.sessions);
    for (const session of sessions) {
      if (stopped) return;
      if (!session?.id) continue;
      const observations = await kv.list<StoredObservation>(KV.observations(session.id));
      for (const row of observations) {
        if (!row?.id || !needsCompression(row) || !compressionRaw(row)) continue;
        // Do not turn the user's historical failures into a retry storm at boot.
        // Failed observations remain recoverable using the manual recovery API.
        if (row.compression?.status === "failed") continue;
        await enqueue({ sessionId: session.id, observationId: row.id });
      }
    }
  }

  async function history(): Promise<Failure[]> {
    const rows = await kv.get<Failure[]>(KV.compressionQueueHistory, "recent");
    return Array.isArray(rows) ? rows.slice(0, HISTORY_LIMIT).map(row => ({ ...row, error: safeError(row.error) })) : [];
  }

  async function recordFailure(job: CompressionQueueJob, error: string, outcome: Failure["outcome"]): Promise<void> {
    // Serialize read-modify-write across concurrent workers. Never store raw prompts.
    try {
      await withKeyedLock("compression-queue-history", async () => {
        const previous = await history();
        const entry: Failure = { sessionId: job.sessionId, observationId: job.observationId,
          at: Date.now(), attempt: job.attempts, error: safeError(error), outcome };
        await kv.set(KV.compressionQueueHistory, "recent", [entry, ...previous].slice(0, HISTORY_LIMIT));
      });
    } catch {
      logger.warn("Compression failure history could not be saved");
    }
  }

  function obsoleteReason(row: StoredObservation | null | undefined, identity: CompressionIdentity): ArchiveReason | undefined {
    if (!row || row.id !== identity.observationId || row.sessionId !== identity.sessionId ||
        needsCompression(row) || !("title" in row) || typeof row.title !== "string" || !row.title.trim()) return undefined;
    if (row.compression?.status === "complete") return "already_complete";
    // Older/synthetic summaries can have no compression metadata. This is
    // NOT evidence of successful LLM processing, only absence of requested work.
    if (row.compression === undefined) return "legacy_no_compression_state";
    return undefined;
  }

  async function archivedJobs(): Promise<ArchivedJob[]> {
    const rows = await kv.get<ArchivedJob[]>(KV.compressionQueueArchive, "recent");
    return Array.isArray(rows) ? rows.slice(0, ARCHIVE_LIMIT).map(row => ({
      ...row, ...(row.lastError ? { lastError: safeError(row.lastError) } : {}),
    })) : [];
  }

  async function reconcileExhausted(): Promise<void> {
    const jobs = await kv.list<CompressionQueueJob>(KV.compressionQueue);
    for (const candidate of jobs) {
      if (stopped) return;
      if (!candidate || candidate.status !== "exhausted" || active.has(candidate.id)) continue;
      await withKeyedLock(`compression-queue:${candidate.id}`, async () => {
        if (active.has(candidate.id)) return;
        const job = await kv.get<CompressionQueueJob>(KV.compressionQueue, candidate.id);
        if (!job || job.status !== "exhausted" ||
            job.id !== compressionQueueKey(job.sessionId, job.observationId)) return;
        await withKeyedLock(`obs:${job.sessionId}`, async () => {
          const row = await kv.get<StoredObservation>(KV.observations(job.sessionId), job.observationId);
          const reason = obsoleteReason(row, job);
          if (!reason) return;
          // Persist the original queue metadata first. If archival fails,
          // leave the queue untouched. A crash between set/delete is idempotent.
          await withKeyedLock("compression-queue-archive", async () => {
            const previous = await archivedJobs();
            if (!previous.some(item => item.id === job.id && item.enqueuedAt === job.enqueuedAt &&
                item.attempts === job.attempts && item.reason === reason)) {
              const entry: ArchivedJob = { ...job, archivedAt: Date.now(), reason,
                ...(job.lastError ? { lastError: safeError(job.lastError) } : {}) };
              await kv.set(KV.compressionQueueArchive, "recent", [entry, ...previous].slice(0, ARCHIVE_LIMIT));
            }
          });
          await kv.delete(KV.compressionQueue, job.id);
        });
      });
    }
  }

  function retryBlock(row: StoredObservation | null | undefined, identity: CompressionIdentity): string | undefined {
    if (!row) return "observation_missing";
    if (row.id !== identity.observationId || row.sessionId !== identity.sessionId) return "identity_mismatch";
    if (!needsCompression(row)) return obsoleteReason(row, identity) ?? "not_failed";
    if (!compressionRaw(row)) return "source_unavailable";
    return undefined;
  }

  async function inspect(cursor?: string, offset = 0) {
    const after = readLegacyCursor(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid queue offset");
    const jobs = (await kv.list<CompressionQueueJob>(KV.compressionQueue)).filter(Boolean);
    const queued = new Set(jobs.map(j => j.id));
    const priority = { exhausted: 0, running: 1, pending: 2 };
    const page = jobs.sort((a, b) => priority[a.status] - priority[b.status] || a.enqueuedAt - b.enqueuedAt)
      .slice(offset, offset + JOB_PAGE_SIZE);
    const visibleJobs = [];
    for (const job of page) {
      let retryBlocked: string | undefined;
      if (job.status === "exhausted") {
        if (active.has(job.id)) retryBlocked = "already_queued";
        else {
          const row = await kv.get<StoredObservation>(KV.observations(job.sessionId), job.observationId);
          retryBlocked = retryBlock(row, job);
        }
      }
      visibleJobs.push({ ...job, ...(job.lastError ? { lastError: safeError(job.lastError) } : {}),
        retryable: job.status === "exhausted" && !retryBlocked,
        ...(retryBlocked ? { retryBlocked } : {}) });
    }
    const legacy: Array<CompressionIdentity & { attempts: number; error: string; at?: string; retryable: boolean }> = [];
    const sessions = (await kv.list<Session>(KV.sessions)).filter(s => typeof s?.id === "string" && s.id)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let scannedSessions = 0;
    let scannedObservations = 0;
    let anchor: [string, string] | undefined = after;
    let more = false;
    outer: for (const session of sessions) {
      if (after && session.id < after[0]) continue;
      if (scannedSessions >= 20) { more = true; break; }
      scannedSessions++;
      if (!after || session.id !== after[0]) anchor = [session.id, ""];
      const rows = (await kv.list<StoredObservation>(KV.observations(session.id))).filter(r => typeof r?.id === "string" && r.id)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const row of rows) {
        if (after && session.id === after[0] && row.id <= after[1]) continue;
        anchor = [session.id, row.id];
        scannedObservations++;
        if (row.sessionId === session.id && row.compression?.status === "failed" && needsCompression(row) &&
            !queued.has(compressionQueueKey(session.id, row.id))) {
          legacy.push({ sessionId: session.id, observationId: row.id,
            attempts: row.compression.attempts ?? 0,
            error: safeError(row.compression.error), at: row.compression.lastAttemptAt,
            retryable: Boolean(compressionRaw(row)) });
        }
        if (legacy.length >= LEGACY_PAGE_SIZE || scannedObservations >= 1000) { more = true; break outer; }
      }
    }
    return { status: await status(), settings, jobs: visibleJobs, totalJobs: jobs.length, jobOffset: offset, jobPageSize: JOB_PAGE_SIZE,
      legacy, history: await history(), historyLimit: HISTORY_LIMIT,
      archived: await archivedJobs(), archiveLimit: ARCHIVE_LIMIT,
      nextCursor: more && anchor ? Buffer.from(JSON.stringify(anchor)).toString("base64url") : null };
  }

  async function retry(input: unknown) {
    const items = input && typeof input === "object" && !Array.isArray(input) ? (input as { items?: unknown }).items : undefined;
    if (!Array.isArray(items) || items.length < 1 || items.length > JOB_PAGE_SIZE || !items.every(validIdentity)) {
      throw new Error("Specify 1–100 valid observation identities");
    }
    let accepted = 0;
    const seen = new Set<string>();
    const results: Array<CompressionIdentity & { outcome: string }> = [];
    for (const item of items) {
      const { sessionId, observationId } = item;
      const id = compressionQueueKey(sessionId, observationId);
      if (seen.has(id)) continue;
      seen.add(id);
      const outcome = await withKeyedLock(`compression-queue:${id}`, async () => {
        const job = await kv.get<CompressionQueueJob>(KV.compressionQueue, id);
        if (active.has(id) || (job && job.status !== "exhausted")) return "already_queued";
        const row = await kv.get<StoredObservation>(KV.observations(sessionId), observationId);
        const blocked = retryBlock(row, item);
        if (blocked) return blocked;
        if (!job && row?.compression?.status !== "failed") return "not_failed";
        const now = Date.now();
        await kv.set(KV.compressionQueue, id, {
          id, sessionId, observationId, enqueuedAt: now, dueAt: now, attempts: 0,
          status: "pending",
        } satisfies CompressionQueueJob);
        return "queued";
      });
      if (outcome === "queued") accepted++;
      results.push({ sessionId, observationId, outcome });
    }
    if (accepted) wake();
    return { accepted, results };
  }

  async function runJob(job: CompressionQueueJob): Promise<void> {
    let failedPass = false;
    try {
      const row = await kv.get<StoredObservation>(KV.observations(job.sessionId), job.observationId);
      if (!row || !needsCompression(row) || !compressionRaw(row)) {
        await kv.delete(KV.compressionQueue, job.id);
        return;
      }

      const claimed: CompressionQueueJob = { ...job, status: "running", attempts: job.attempts + 1 };
      await kv.set(KV.compressionQueue, job.id, claimed);
      let result: CompressionResult;
      try {
        result = await sdk.trigger<CompressionIdentity & { expectedRevision: string }, CompressionResult>({
          function_id: "mem::compress",
          payload: {
            sessionId: job.sessionId, observationId: job.observationId,
            expectedRevision: observationRevision(row),
          },
        });
      } catch {
        result = { success: false, error: "provider_failure" };
      }

      if (result?.success || result?.skipped) {
        if (result?.success && !result.skipped) completed++;
        await kv.delete(KV.compressionQueue, job.id);
      } else {
        failures++;
        const failureError = safeError(result?.error || "compression_failed");
        lastError = failureError;
        if (result?.retryable === false) {
          await kv.delete(KV.compressionQueue, job.id);
          await recordFailure(claimed, failureError, "not_retryable");
        } else {
          const exhausted = claimed.attempts >= maxAttempts;
          const retryDelay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(claimed.attempts - 1, 20));
          await kv.set(KV.compressionQueue, job.id, {
            ...claimed, status: exhausted ? "exhausted" : "pending",
            dueAt: Date.now() + retryDelay,
            lastError: failureError,
          } satisfies CompressionQueueJob);
          await recordFailure(claimed, failureError, exhausted ? "exhausted" : "retry_scheduled");
        }
      }
    } catch {
      failedPass = true;
      lastError = "queue_processing_failed";
      logger.warn("Compression queue job failed", { error: lastError });
    } finally {
      active.delete(job.id);
      if (failedPass && !stopped && started) schedule(10_000);
      else wake();
    }
  }

  // One dispatcher claims distinct jobs; each completion immediately makes
  // its slot available rather than waiting for the slowest job in a batch.
  async function drain(): Promise<void> {
    if (stopped || pumping || active.size >= concurrency) return;
    pumping = true;
    const launched: Promise<void>[] = [];
    let failedPass = false;
    try {
      if (Date.now() >= backfillAt) {
        backfillAt = Date.now() + backfillMs;
        await reconcileExhausted();
        await recoverFromObservations();
      }
      const jobs = await kv.list<CompressionQueueJob>(KV.compressionQueue);
      const due = jobs
        .filter(job => job && job.status !== "exhausted" && !active.has(job.id) && job.dueAt <= Date.now())
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .slice(0, Math.min(JOB_BATCH, concurrency - active.size));
      for (const job of due) {
        if (stopped || active.size >= concurrency) break;
        active.add(job.id);
        launched.push(runJob(job));
      }
      if (!stopped && started && active.size < concurrency) {
        const next = jobs.filter(j => j && j.status !== "exhausted" && !active.has(j.id))
          .reduce((min, j) => Math.min(min, j.dueAt), backfillAt);
        schedule(Math.max(0, next - Date.now()));
      }
    } catch {
      failedPass = true;
      lastError = "queue_processing_failed";
      logger.warn("Compression queue pass failed", { error: lastError });
    } finally {
      pumping = false;
      const requested = wakePending;
      wakePending = false;
      if (failedPass) schedule(10_000);
      else if (requested) wake();
    }
    await Promise.all(launched);
  }

  async function status(): Promise<CompressionQueueStatus> {
    const jobs = await kv.list<CompressionQueueJob>(KV.compressionQueue);
    const now = Date.now();
    const pending = jobs.filter((job) => job.status === "pending" || job.status === "running");
    return {
      pending: pending.filter((job) => job.status === "pending").length,
      running: active.size,
      exhausted: jobs.filter((job) => job.status === "exhausted").length,
      oldestPendingAgeMs: pending.length ? Math.max(0, now - Math.min(...pending.map((j) => j.enqueuedAt))) : null,
      completedSinceStart: completed,
      failuresSinceStart: failures,
      ...(lastError ? { lastError } : {}),
    };
  }

  sdk.registerFunction("mem::compression-enqueue", enqueue);
  sdk.registerFunction("mem::compression-queue-status", status);

  return {
    start: () => { if (!started && !stopped) { started = true; schedule(0); } },
    stop: () => { stopped = true; if (timer) clearTimeout(timer); },
    drain,
    status,
    inspect,
    retry,
  };
}
