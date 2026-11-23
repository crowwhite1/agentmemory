import type { IIIClient } from "iii-sdk";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { observationRevision, needsCompression, compressionRaw, type StoredObservation } from "./compression-state.js";
import type { Session, CompressionQueueJob, CompressionQueueStatus } from "../types.js";
import { logger } from "../logger.js";

type CompressionResult = { success?: boolean; skipped?: boolean; retryable?: boolean; error?: string };
type CompressionIdentity = { sessionId: string; observationId: string };

const JOB_BATCH = 64;

function boundedInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw || !/^\\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

export function compressionQueueKey(sessionId: string, observationId: string): string {
  return fingerprintId("compression-job", JSON.stringify([sessionId, observationId]));
}

export function registerCompressionQueue(sdk: IIIClient, kv: StateKV): {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
  status(): Promise<CompressionQueueStatus>;
} {
  let stopped = false;
  let started = false;
  let active = false;
  let completed = 0;
  let failures = 0;
  let lastError: string | undefined;
  const backfillMs = boundedInt("AGENTMEMORY_COMPRESSION_QUEUE_BACKFILL_MS", 300_000, 30_000, 86_400_000);
  const maxAttempts = boundedInt("AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS", 2, 1, 20);
  let backfillAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function enqueue(identity: CompressionIdentity): Promise<boolean> {
    if (!identity?.sessionId || !identity?.observationId) return false;
    const stored = await kv.get<StoredObservation>(
      KV.observations(identity.sessionId), identity.observationId,
    );
    if (!stored || !needsCompression(stored) || !compressionRaw(stored)) return false;
    const id = compressionQueueKey(identity.sessionId, identity.observationId);
    const existing = await kv.get<CompressionQueueJob>(KV.compressionQueue, id);
    if (existing) return false;
    const now = Date.now();
    const job: CompressionQueueJob = {
      id, sessionId: identity.sessionId, observationId: identity.observationId,
      enqueuedAt: now, dueAt: now, attempts: 0, status: "pending",
    };
    await kv.set(KV.compressionQueue, id, job);
    wake();
    return true;
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
    if (!stopped && started && !active) schedule(0);
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

  async function drain(): Promise<void> {
    if (stopped || active) return;
    active = true;
    try {
      const now = Date.now();
      if (now >= backfillAt) {
        backfillAt = now + backfillMs;
        await recoverFromObservations();
      }
      const jobs = await kv.list<CompressionQueueJob>(KV.compressionQueue);
      const due = jobs
        .filter((job) => job && job.status !== "exhausted" && job.dueAt <= now)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .slice(0, JOB_BATCH);
      const job = due[0];
      if (!job) return;
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
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : "provider_failure" };
      }

      if (result?.success || result?.skipped || result?.retryable === false) {
        if (result?.success && !result.skipped) completed++;
        await kv.delete(KV.compressionQueue, job.id);
      } else {
        failures++;
        lastError = result?.error || "compression_failed";
        const exhausted = claimed.attempts >= maxAttempts;
        const retryDelay = Math.min(300_000, 15_000 * 2 ** Math.min(claimed.attempts - 1, 5));
        await kv.set(KV.compressionQueue, job.id, {
          ...claimed, status: exhausted ? "exhausted" : "pending",
          dueAt: Date.now() + retryDelay,
          lastError,
        } satisfies CompressionQueueJob);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "queue_processing_failed";
      logger.warn("Compression queue pass failed", { error: lastError });
    } finally {
      active = false;
      if (!stopped && started) {
        try {
          const jobs = await kv.list<CompressionQueueJob>(KV.compressionQueue);
          const due = jobs.filter((j) => j && j.status !== "exhausted")
            .reduce((min, j) => Math.min(min, j.dueAt), backfillAt);
          schedule(Math.max(0, due - Date.now()));
        } catch {
          schedule(backfillMs);
        }
      }
    }
  }

  async function status(): Promise<CompressionQueueStatus> {
    const jobs = await kv.list<CompressionQueueJob>(KV.compressionQueue);
    const now = Date.now();
    const pending = jobs.filter((job) => job.status === "pending" || job.status === "running");
    return {
      pending: pending.filter((job) => job.status === "pending").length,
      running: active ? 1 : 0,
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
  };
}
