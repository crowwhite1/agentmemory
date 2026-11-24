import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredProjects } from "../src/viewer/control-projects.js";

describe("project control registry", () => {
  it("uses separate paths and rejects duplicate instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-project-registry-"));
    const registry = join(dir, "registry.json");
    try {
      const a = join(dir, "a");
      const b = join(dir, "b");
      writeFileSync(registry, JSON.stringify({ [a]: { instance: 1, base: dir }, [b]: { instance: 2, base: dir } }));
      const entries = registeredProjects(registry);
      expect(entries[0]?.dataDir).toBe(join(dir, "instance-1"));
      expect(entries[1]?.dataDir).toBe(join(dir, "instance-2"));
      writeFileSync(registry, JSON.stringify({ [a]: { instance: 1, base: dir }, [b]: { instance: 1, base: dir } }));
      expect(() => registeredProjects(registry)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
