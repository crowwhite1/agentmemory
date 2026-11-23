import { describe, expect, it, vi } from "vitest";
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
