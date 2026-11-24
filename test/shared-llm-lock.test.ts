import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withSharedLlmLock } from "../src/providers/shared-lock.js";

const supported = process.platform !== "win32" && spawnSync("python3", ["-c", "import fcntl"]).status === 0;

describe.skipIf(!supported)("shared LLM lock", () => {
  it("serializes independent lock holders and releases on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-lock-"));
    const path = join(dir, "shared.lock");
    let active = 0;
    let peak = 0;
    try {
      const work = () => withSharedLlmLock(path, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 30));
        active--;
      });
      await Promise.all([work(), work(), work()]);
      expect(peak).toBe(1);
      await expect(withSharedLlmLock(path, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
      await work();
      expect(active).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
