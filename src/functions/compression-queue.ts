import type { IIIClient } from "iii-sdk";
import { KV, fingerprintId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { observationRevision, needsCompression, compressionRaw, type StoredObservation } from "./compression-state.js";
import type { Session } from "../types.js";
import { logger } from "../logger.js";

export type CompressionQueueJob = {
  id: string;
  sessionId: string;
  observationId: string;
  enqueuedAt: number;
  dueAt: number;
  attempts: number;
  status: "pending" | "running" | "exhausted";
  lastError?: string;
};

export type CompressionQueueStatus = {
  pending: number;
  running: number;
  exhausted: number;
  oldestPendingAgeMs: number | null;
  completedSinceStart: number;
  failuresSinceStart: number;
  lastError?: string;
};

type CompressionResult = { success?: boolean; skipped?: boolean; retryable?: boolean; error?: string };
type CompressionIdentity = { sessionId: string; observationId: string };

const POLL_MS = 2_000;
const BACKFILL_MS = 60_000;
const JOB_BATCH = 64;
const MAX_ATTEMPTS = 2;

export function compressionQueueKey(sessionId: string, observationId: string): string {
  return fingerprintId("compression-job", JSON.stringify([sessionId, observationId]));
}

export function registerCompressionQueue(sdk: IIIClient, kv: StateKV): {
  stop(): void;
  drain(): Promise<void>;
  status(): Promise<CompressionQueueStatus>;
} {
  let stopped = false;
  let active = false;
  let completed = 0;
  let failures = 0;
  let lastError: string | undefined;
  let backfillAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

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
    return true;
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
        backfillAt = now + BACKFILL_MS;
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
        const exhausted = claimed.attempts >= MAX_ATTEMPTS;
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

  timer = setInterval(() => { void drain(); }, POLL_MS);
  timer.unref();
  // The first sweep also picks up pending captures left behind by a crash.
  void drain();
  return {
    stop: () => { stopped = true; if (timer) clearInterval(timer); },
    drain,
    status,
  };
}
