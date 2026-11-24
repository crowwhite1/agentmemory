import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSettings, renderSettingsDocument, updateSettings } from "../src/viewer/control-settings.js";

const originalEnvPath = process.env["AGENTMEMORY_ENV_FILE"];
const directories: string[] = [];
function useConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmemory-settings-"));
  directories.push(dir);
  const file = join(dir, ".env");
  writeFileSync(file, content, { mode: 0o600 });
  process.env["AGENTMEMORY_ENV_FILE"] = file;
  return file;
}
afterEach(() => {
  if (originalEnvPath === undefined) delete process.env["AGENTMEMORY_ENV_FILE"];
  else process.env["AGENTMEMORY_ENV_FILE"] = originalEnvPath;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("viewer settings", () => {
  it("lists the documented .env settings with descriptions", () => {
    useConfig("AGENTMEMORY_AUTO_COMPRESS=true\n");
    const entries = listSettings();
    const auto = entries.find((entry) => entry.key === "AGENTMEMORY_AUTO_COMPRESS");
    expect(entries.length).toBeGreaterThan(40);
    expect(auto?.configured).toBe(true);
    expect(auto?.value).toBe("true");
    expect(auto?.description?.length).toBeGreaterThan(12);
  });

  it("always exposes queue controls and validates their ranges", () => {
    const path = useConfig("OPENAI_MODEL=qwen\n");
    const queue = listSettings().filter(entry => entry.group === "Очередь компрессии");
    expect(queue).toHaveLength(6);
    expect(() => updateSettings({ AGENTMEMORY_LLM_MAX_CONCURRENT_REQUESTS: "17" })).toThrow();
    expect(queue.find(entry => entry.key === "AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS")?.example).toBe("2");
    expect(() => updateSettings({ AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS: "0" })).toThrow();
    expect(() => updateSettings({ AGENTMEMORY_COMPRESSION_QUEUE_BACKFILL_MS: "100" })).toThrow();
    expect(updateSettings({ AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS: "4", AGENTMEMORY_COMPRESSION_QUEUE_RETRY_BASE_MS: "20000" })).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toContain("AGENTMEMORY_COMPRESSION_QUEUE_MAX_ATTEMPTS=4");
  });

  it("never sends local API keys back to the browser", () => {
    useConfig("OPENAI_API_KEY=local-secret-token\n");
    const key = listSettings().find((entry) => entry.key === "OPENAI_API_KEY");
    expect(key?.configured).toBe(true);
    expect(key?.secret).toBe(true);
    expect(JSON.stringify(listSettings())).not.toContain("local-secret-token");
  });

  it("atomically writes selected values, preserving unrelated comments", () => {
    const path = useConfig("# keep me\nAGENTMEMORY_AUTO_COMPRESS=true\nOPENAI_MODEL=old-model\n");
    expect(updateSettings({
      OPENAI_MODEL: "qwen3-4b-instruct-2507-mlx",
      AGENTMEMORY_AUTO_COMPRESS: "true",
    })).toEqual(["OPENAI_MODEL", "AGENTMEMORY_AUTO_COMPRESS"]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("OPENAI_MODEL=qwen3-4b-instruct-2507-mlx");
    expect(text.match(/OPENAI_MODEL=/g)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects arbitrary keys and newline injection", () => {
    useConfig("OPENAI_MODEL=old\n");
    expect(() => updateSettings({ EVIL_UNKNOWN_KEY: "bad" })).toThrow();
    expect(() => updateSettings({ OPENAI_MODEL: "good\nAGENTMEMORY_SECRET=exfiltrated" })).toThrow();
  });

  it("renders a CSP-protected page without periodic health polling", () => {
    const page = renderSettingsDocument();
    expect(page.html).toContain("Настройки AgentMemory");
    expect(page.html).not.toContain("__AGENTMEMORY_VIEWER_NONCE__");
    expect(page.csp).toContain("script-src 'nonce-");
    expect(page.html).not.toContain("setInterval");
    expect(page.html).toContain("Журнал неудачных попыток");
    expect(page.html).toContain("/settings/queue/retry");
  });
});
