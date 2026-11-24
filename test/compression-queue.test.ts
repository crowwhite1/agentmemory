import { afterEach, describe, expect, it, vi } from "vitest";
import { readCompressionQueueSettings } from "../src/functions/compression-queue-config.js";

afterEach(() => vi.unstubAllEnvs());
import { registerCompressionQueue, compressionQueueKey } from "../src/functions/compression-queue.js";
import { KV } from "../src/state/schema.js";
import type { RawObservation } from "../src/types.js";

function rig() {
  const state = new Map<string, Map<string, unknown>>();
  const bucket = (scope: string) => {
    if (!state.has(scope)) state.set(scope, new Map());
    return state.get(scope)!;
  };
  const kv = {
    get: vi.fn(async (scope: string, key: string) => bucket(scope).get(key) ?? null),
    list: vi.fn(async (scope: string) => [...bucket(scope).values()]),
    set: vi.fn(async (scope: string, key: string, value: unknown) => {
      bucket(scope).set(key, structuredClone(value));
      return value;
    }),
    delete: vi.fn(async (scope: string, key: string) => { bucket(scope).delete(key); }),
  };
  const handlers = new Map<string, (arg: never) => Promise<unknown>>();
  const trigger = vi.fn(async (req: { function_id: string; payload: never }) => {
    const handler = handlers.get(req.function_id);
    if (handler) return handler(req.payload);
    if (req.function_id === "mem::compress") return { success: true };
    throw new Error("unknown: " + req.function_id);
  });
  const sdk = {
    registerFunction: (name: string, fn: (arg: never) => Promise<unknown>) => handlers.set(name, fn),
    trigger,
  };
  const raw: RawObservation = {
    id: "obs-1", sessionId: "session-1",
    timestamp: "2026-11-23T00:00:00Z", hookType: "post_tool_use",
    toolOutput: "Tests passed", raw: { toolOutput: "Tests passed" },
  };
  const observation = { ...raw, compression: { status: "pending", revision: "r1", attempts: 0 } };
  bucket(KV.sessions).set("session-1", {
    id: "session-1", status: "active", project: "crowisp", cwd: "/tmp",
    startedAt: raw.timestamp, observationCount: 1,
  });
  bucket(KV.observations(raw.sessionId)).set(raw.id, observation);
  return { kv, sdk, handlers, bucket, raw };
}

describe("StateKV compression queue", () => {
  it("persists job and completes one observation", async () => {
    const { kv, sdk, handlers, bucket } = rig();
    const work = registerCompressionQueue(sdk as never, kv as never);
    try {
      const enqueue = handlers.get("mem::compression-enqueue")!;
      await enqueue({ sessionId: "session-1", observationId: "obs-1" } as never);
      await work.drain();
      const stats = await work.status();
      expect(stats.completedSinceStart).toBe(1);
      expect(bucket(KV.compressionQueue).size).toBe(0);
      expect(sdk.trigger).toHaveBeenCalledWith(expect.objectContaining({
        function_id: "mem::compress",
      }));
    } finally {
      work.stop();
    }
  });

  it("deduplicates the same observation and keeps retry limit after restart", async () => {
    const { kv, sdk, handlers, bucket } = rig();
    const worker = registerCompressionQueue(sdk as never, kv as never);
    const enqueue = handlers.get("mem::compression-enqueue")!;
    sdk.trigger.mockImplementation(async (req) => {
      if (req.function_id === "mem::compress") return { success: false, error: "validation_failed" };
      const handler = handlers.get(req.function_id);
      return handler?.(req.payload);
    });
    await enqueue({ sessionId: "session-1", observationId: "obs-1" } as never);
    await enqueue({ sessionId: "session-1", observationId: "obs-1" } as never);
    await worker.drain();
    expect(bucket(KV.compressionQueue).size).toBe(1);
    const item = bucket(KV.compressionQueue).get(compressionQueueKey("session-1", "obs-1")) as { attempts: number; status: string; dueAt: number };
    expect(item.attempts).toBe(1);
    worker.stop();
    const restored = registerCompressionQueue(sdk as never, kv as never);
    try {
      await kv.set(KV.compressionQueue, compressionQueueKey("session-1", "obs-1"), { ...item, dueAt: 0 });
      await restored.drain();
      const next = bucket(KV.compressionQueue).get(compressionQueueKey("session-1", "obs-1")) as { attempts: number; status: string };
      expect(next.attempts).toBe(2);
      expect(next.status).toBe("exhausted");
    } finally {
      restored.stop();
    }
  });

  it("retains failures across worker restart and successful manual retry", async () => {
    vi.stubEnv("AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS", "1");
    const { kv, sdk, handlers, bucket } = rig();
    const first = registerCompressionQueue(sdk as never, kv as never);
    const identity = { sessionId: "session-1", observationId: "obs-1" };
    await handlers.get("mem::compression-enqueue")!(identity as never);
    sdk.trigger.mockResolvedValueOnce({ success: false, error: "parse_failed" });
    try {
      await first.drain();
      expect((await first.status()).exhausted).toBe(1);
    } finally { first.stop(); }
    const restored = registerCompressionQueue(sdk as never, kv as never);
    try {
      expect(await restored.inspect()).toMatchObject({
        history: [{ ...identity, attempt: 1, error: "parse_failed", outcome: "exhausted" }],
        jobs: [{ ...identity, status: "exhausted" }],
      });
      const callCount = sdk.trigger.mock.calls.length;
      expect(await restored.retry({ items: [identity, identity] })).toMatchObject({ accepted: 1 });
      expect(await restored.retry({ items: [identity] })).toMatchObject({ accepted: 0, results: [{ outcome: "already_queued" }] });
      expect(sdk.trigger.mock.calls.length).toBe(callCount);
      const job = bucket(KV.compressionQueue).get(compressionQueueKey(identity.sessionId, identity.observationId));
      expect(job).toMatchObject({ status: "pending", attempts: 0 });
      await restored.drain();
      expect((await restored.status()).exhausted).toBe(0);
      expect(await restored.inspect()).toMatchObject({
        jobs: [], history: [{ ...identity, error: "parse_failed" }],
      });
    } finally { restored.stop(); }
  });

  it("finds legacy failures outside the queue and queues only recoverable sources", async () => {
    const { kv, sdk, bucket, raw } = rig();
    const compression = { status: "failed", revision: "old", attempts: 3, error: "validation_failed" };
    bucket(KV.observations(raw.sessionId)).set(raw.id, { ...raw, compression });
    bucket(KV.observations(raw.sessionId)).set("missing-source", {
      id: "missing-source", sessionId: raw.sessionId, hookType: raw.hookType, timestamp: raw.timestamp, compression,
    });
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      expect(await worker.inspect()).toMatchObject({ jobs: [], legacy: [
        { observationId: "missing-source", retryable: false },
        { observationId: raw.id, retryable: true, error: "validation_failed" },
      ] });
      expect(await worker.retry({ items: [
        { sessionId: raw.sessionId, observationId: "missing-source" },
        { sessionId: raw.sessionId, observationId: raw.id },
      ] })).toMatchObject({ accepted: 1, results: [{ outcome: "source_unavailable" }, { outcome: "queued" }] });
      expect(await worker.inspect()).toMatchObject({ legacy: [{ observationId: "missing-source" }], jobs: [{ observationId: raw.id }] });
      expect(sdk.trigger).not.toHaveBeenCalled();
    } finally { worker.stop(); }
  });

  it("exposes why exhausted jobs cannot be retried without invoking the model or deleting evidence", async () => {
    const { kv, sdk, bucket, raw } = rig();
    const compression = { status: "failed", revision: "old", attempts: 2, error: "parse_failed" };
    const ids = ["missing", "source-less", "complete", "recoverable"];
    for (const observationId of ids) {
      const id = compressionQueueKey(raw.sessionId, observationId);
      bucket(KV.compressionQueue).set(id, { id, sessionId: raw.sessionId, observationId,
        enqueuedAt: 1, dueAt: 0, attempts: 2, status: "exhausted", lastError: "parse_failed" });
    }
    bucket(KV.observations(raw.sessionId)).set("source-less", { id: "source-less",
      sessionId: raw.sessionId, timestamp: raw.timestamp, hookType: raw.hookType, compression });
    bucket(KV.observations(raw.sessionId)).set("complete", { ...raw, id: "complete", title: "Done", compression: {...compression, status: "complete"} });
    bucket(KV.observations(raw.sessionId)).set("recoverable", { ...raw, id: "recoverable", compression });
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      expect(await worker.inspect()).toMatchObject({ jobs: [
        { observationId: "missing", retryable: false, retryBlocked: "observation_missing" },
        { observationId: "source-less", retryable: false, retryBlocked: "source_unavailable" },
        { observationId: "complete", retryable: false, retryBlocked: "already_complete" },
        { observationId: "recoverable", retryable: true },
      ] });
      expect(await worker.retry({items: ids.map(observationId => ({sessionId: raw.sessionId, observationId}))})).toMatchObject({
        accepted: 1, results: [{outcome: "observation_missing"}, {outcome: "source_unavailable"}, {outcome: "already_complete"}, {outcome: "queued"}],
      });
      expect(sdk.trigger).not.toHaveBeenCalled();
      expect(bucket(KV.compressionQueue).size).toBe(4);
      expect(bucket(KV.compressionQueue).get(compressionQueueKey(raw.sessionId, "recoverable"))).toMatchObject({status:"pending", attempts:0});
      expect(bucket(KV.compressionQueue).get(compressionQueueKey(raw.sessionId, "recoverable"))).not.toHaveProperty("lastError");
      expect(bucket(KV.observations(raw.sessionId)).get("source-less")).toMatchObject({compression});
    } finally { worker.stop(); }
  });

  it("archives obsolete exhausted jobs at recovery without touching observations or invoking the model", async () => {
    const { kv, sdk, bucket, raw } = rig();
    const observationBucket = bucket(KV.observations(raw.sessionId));
    observationBucket.delete(raw.id);
    const summary = { ...raw, title: "Existing summary" };
    const done = { ...summary, id: "done", compression: { status: "complete", revision: "r", attempts: 2 } };
    const legacy = { ...summary, id: "legacy" };
    const failed = { ...summary, id: "failed", compression: { status: "failed", revision: "r", attempts: 2 } };
    for (const row of [done, legacy, failed]) observationBucket.set(row.id, row);
    for (const observationId of ["done", "legacy", "failed", "missing"]) {
      const id = compressionQueueKey(raw.sessionId, observationId);
      bucket(KV.compressionQueue).set(id, { id, sessionId: raw.sessionId, observationId,
        status: "exhausted", enqueuedAt: 1, dueAt: 0, attempts: 2, lastError: "parse_failed" });
    }
    const before = structuredClone([...observationBucket.entries()]);
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      await worker.drain();
      expect(sdk.trigger).not.toHaveBeenCalled();
      expect([...observationBucket.entries()]).toEqual(before);
      expect((await worker.status()).exhausted).toBe(2);
      expect((await worker.status()).completedSinceStart).toBe(0);
      expect((await worker.status()).failuresSinceStart).toBe(0);
      expect(await worker.inspect()).toMatchObject({
        archived: expect.arrayContaining([
          expect.objectContaining({observationId:"done", reason:"already_complete", lastError:"parse_failed"}),
          expect.objectContaining({observationId:"legacy", reason:"legacy_no_compression_state", lastError:"parse_failed"}),
        ]),
        jobs: expect.arrayContaining([expect.objectContaining({observationId:"failed"}),expect.objectContaining({observationId:"missing"})]),
      });
    } finally { worker.stop(); }
    const restarted = registerCompressionQueue(sdk as never, kv as never);
    try {
      await restarted.drain();
      expect(await restarted.inspect()).toMatchObject({archived: expect.arrayContaining([
        expect.objectContaining({observationId:"done"}), expect.objectContaining({observationId:"legacy"}),
      ])});
      expect(bucket(KV.compressionQueueArchive).get("recent")).toHaveLength(2);
    } finally { restarted.stop(); }
  });

  it("does not remove an obsolete job if writing its archive fails", async () => {
    const { kv, sdk, bucket, raw } = rig();
    bucket(KV.observations(raw.sessionId)).set(raw.id, {...raw, title:"Existing summary"});
    const id = compressionQueueKey(raw.sessionId, raw.id);
    const job = {id, sessionId:raw.sessionId, observationId:raw.id, status:"exhausted", attempts:2, enqueuedAt:1, dueAt:0, lastError:"parse_failed"};
    bucket(KV.compressionQueue).set(id,job);
    kv.set.mockRejectedValueOnce(new Error("archive storage unavailable"));
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      await worker.drain();
      expect(bucket(KV.compressionQueue).get(id)).toEqual(job);
      expect(sdk.trigger).not.toHaveBeenCalled();
    } finally { worker.stop(); }
  });

  it("uses validated retry delays and does not log raw provider errors", async () => {
    vi.stubEnv("AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS", "2");
    vi.stubEnv("AGENTMEMORY_COMPRESSION_QUEUE_RETRY_BASE_MS", "2000");
    vi.stubEnv("AGENTMEMORY_COMPRESSION_QUEUE_RETRY_MAX_MS", "3000");
    const { kv, sdk, handlers, raw, bucket } = rig();
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      await handlers.get("mem::compression-enqueue")!({ sessionId: raw.sessionId, observationId: raw.id } as never);
      sdk.trigger.mockResolvedValueOnce({ success: false, error: "private provider payload" });
      const before = Date.now();
      await worker.drain();
      const job = bucket(KV.compressionQueue).get(compressionQueueKey(raw.sessionId, raw.id)) as { dueAt: number };
      expect(job.dueAt).toBeGreaterThanOrEqual(before + 2000);
      expect(job.dueAt).toBeLessThanOrEqual(Date.now() + 2000);
      const snapshot = await worker.inspect();
      expect(snapshot).toMatchObject({ history: [{ error: "provider_failure", outcome: "retry_scheduled" }] });
      expect(JSON.stringify(snapshot)).not.toContain("private provider payload");
      expect(readCompressionQueueSettings({ AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS: "1000" }).maxAttempts).toBe(2);
    } finally { worker.stop(); }
  });

  it("fills parallel slots with distinct jobs and retains concurrent failure records", async () => {
    vi.stubEnv("AGENTMEMORY_LLM_MAX_CONCURRENT_REQUESTS", "2");
    vi.stubEnv("AGENTMEMORY_COMPRESSION_QUEUE_CONCURRENCY", "4");
    vi.stubEnv("AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS", "1");
    const { kv, sdk, handlers, bucket, raw } = rig();
    for (let i = 2; i <= 3; i++) {
      bucket(KV.observations(raw.sessionId)).set("obs-" + i, { ...raw, id: "obs-" + i });
    }
    const releases: Array<() => void> = [];
    const ids: string[] = [];
    sdk.trigger.mockImplementation(async req => {
      if (req.function_id !== "mem::compress") return handlers.get(req.function_id)?.(req.payload);
      ids.push((req.payload as unknown as { observationId: string }).observationId);
      await new Promise<void>(resolve => releases.push(resolve));
      return { success: false, error: "parse_failed" };
    });
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      const pass = worker.drain();
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      expect((await worker.status()).running).toBe(2);
      await worker.drain();
      expect(ids).toHaveLength(2);
      releases.splice(0).forEach(resolve => resolve());
      await pass;
      const next = worker.drain();
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases.splice(0).forEach(resolve => resolve());
      await next;
      expect(new Set(ids).size).toBe(3);
      expect((await worker.status()).exhausted).toBe(3);
      expect(await worker.inspect()).toMatchObject({ history: expect.arrayContaining(
        ids.map(observationId => expect.objectContaining({ observationId, error: "parse_failed" }))
      ) });
    } finally {
      releases.splice(0).forEach(resolve => resolve());
      worker.stop();
    }
  });

  it("resumes a persisted running job after a crash", async () => {
    const { kv, sdk, bucket } = rig();
    bucket(KV.compressionQueue).set(compressionQueueKey("session-1", "obs-1"), {
      id: compressionQueueKey("session-1", "obs-1"),
      sessionId: "session-1", observationId: "obs-1",
      status: "running", enqueuedAt: 1000, dueAt: 0, attempts: 1,
    });
    const worker = registerCompressionQueue(sdk as never, kv as never);
    try {
      await worker.drain();
      expect(bucket(KV.compressionQueue).size).toBe(0);
      expect((await worker.status()).completedSinceStart).toBe(1);
    } finally {
      worker.stop();
    }
  });
});
