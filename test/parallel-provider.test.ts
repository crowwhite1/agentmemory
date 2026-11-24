import { afterEach, describe, expect, it, vi } from "vitest";
import { SerializedMemoryProvider } from "../src/providers/serialized.js";
afterEach(() => vi.unstubAllEnvs());

describe("bounded LLM provider", () => {
  it("shares two local slots between compression and summaries", async () => {
    vi.stubEnv("AGENTMEMORY_LLM_MAX_CONCURRENT_REQUESTS", "2");
    vi.stubEnv("AGENTMEMORY_LLM_LOCK_FILE", "");
    const releases: Array<() => void> = [];
    const work = vi.fn(async () => {
      await new Promise<void>(resolve => releases.push(resolve));
      return "ok";
    });
    const provider = new SerializedMemoryProvider({ name: "test", compress: work, summarize: work });
    const tasks = [provider.compress("s","u"), provider.summarize("s","u"), provider.compress("s","u")];
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2));
    expect(provider.status).toEqual({active: 2, pending: 1});
    releases.shift()!();
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach(resolve => resolve());
    expect(await Promise.all(tasks)).toEqual(["ok","ok","ok"]);
    await vi.waitFor(() => expect(provider.status).toEqual({active: 0, pending: 0}));
  });
});
