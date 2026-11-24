import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { startViewerServer } from "../src/viewer/server.js";

describe("local Viewer compression queue controls", () => {
  it("reads the selected worker and requires same-origin POST for retry", async () => {
    const inspect = vi.fn(async () => ({ jobs: [], history: [] }));
    const retry = vi.fn(async () => ({ accepted: 1 }));
    const server = startViewerServer(0, {}, {}, undefined, 0, { inspect, retry });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ items: [{ sessionId: "session", observationId: "obs" }] });
    try {
      const get = await fetch(base + "/settings/queue?offset=100");
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({ jobs: [], history: [] });
      expect(inspect).toHaveBeenCalledWith(undefined, 100);
      for (const origin of [undefined, "https://example.org"]) {
        const res = await fetch(base + "/settings/queue/retry", {
          method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body,
        });
        expect(res.status).toBe(403);
        await res.text();
      }
      expect(retry).not.toHaveBeenCalled();
      const allowed = await fetch(base + "/settings/queue/retry", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body,
      });
      expect(allowed.status).toBe(202);
      expect(await allowed.json()).toEqual({ accepted: 1 });
      expect(retry).toHaveBeenCalledWith(JSON.parse(body));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
