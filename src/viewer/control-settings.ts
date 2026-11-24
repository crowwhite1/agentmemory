import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createViewerNonce, buildViewerCsp, VIEWER_NONCE_PLACEHOLDER } from "../auth.js";
import { parseEnvContent } from "../config.js";
import { compressionQueueSettings, validQueueSetting } from "../functions/compression-queue-config.js";

export interface SettingsEntry {
  key: string;
  description: string;
  group: string;
  example: string;
  value: string;
  configured: boolean;
  secret: boolean;
  environmentOverride: boolean;
}

const SECRET_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)/i;
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const CUSTOM_VALUE_MAX = 4096;

function rootCandidates(file: string): string[] {
  const base = dirname(fileURLToPath(import.meta.url));
  return [
    join(base, "..", "..", file),
    join(base, "..", file),
    join(base, file),
  ];
}

function templateContent(): string {
  for (const path of rootCandidates(".env.example")) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("Bundled .env.example is missing");
}

export function settingsFilePath(): string {
  return process.env["AGENTMEMORY_SHARED_SETTINGS_FILE"] || process.env["AGENTMEMORY_ENV_FILE"] || join(homedir(), ".agentmemory", ".env");
}

function envFileContent(): string {
  const path = settingsFilePath();
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function descriptions(): Map<string, Omit<SettingsEntry, "value" | "configured" | "secret" | "environmentOverride">> {
  const map = new Map<string, Omit<SettingsEntry, "value" | "configured" | "secret" | "environmentOverride">>();
  let group = "Общие";
  let note: string[] = [];
  for (const line of templateContent().split(/\r?\n/)) {
    const section = /^#\s*\d+\.\s+(.+?)\s*$/.exec(line);
    if (section) { group = section[1]!; note = []; continue; }
    if (/^#\s*---/.test(line) || /^#\s*===/.test(line)) { note = []; continue; }
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=([^#\r\n]*?)(?:\s+#\s*(.*))?$/.exec(line);
    if (match) {
      const key = match[1]!;
      if (!KEY_PATTERN.test(key)) continue;
      const explanation = (match[3] || note.slice(-3).join(" ")).trim();
      map.set(key, {
        key, group, example: match[2]!.trim(),
        description: explanation || "Переменная окружения AgentMemory. Подробности — в .env.example.",
      });
      note = [];
    } else if (/^#\s+\S/.test(line)) {
      const text = line.replace(/^#\s*/, "").trim();
      if (text.length > 12 && !text.startsWith("#")) note.push(text);
      if (note.length > 4) note.shift();
    } else if (!line.trim()) note = [];
  }
  return map;
}

export function listSettings(): SettingsEntry[] {
  const known = descriptions();
  for (const [key, rule] of Object.entries(compressionQueueSettings)) {
    known.set(key, { key, group: "Очередь компрессии", example: String(rule.fallback), description: rule.description });
  }
  known.set("OPENAI_COMPRESSION_FORMAT", { key: "OPENAI_COMPRESSION_FORMAT", group: "Формат компрессии", example: "xml", description: "xml (по умолчанию) или json_schema (структурированный JSON, если модель и runtime поддерживают). Применяется после перезапуска." });
  const configured = parseEnvContent(envFileContent());
  for (const key of Object.keys(configured)) {
    if (!KEY_PATTERN.test(key)) continue;
    if (!known.has(key)) known.set(key, {
      key, group: "Другие параметры", example: "",
      description: "Параметр из текущего конфигурационного файла. Описание отсутствует в .env.example.",
    });
  }
  return [...known.values()].map((entry) => {
    const secret = SECRET_PATTERN.test(entry.key);
    const value = configured[entry.key];
    const environmentOverride = process.env[entry.key] !== undefined && process.env[entry.key] !== value;
    return {
      ...entry, secret, configured: value !== undefined,
      value: secret ? "" : (value || ""),
      environmentOverride,
    };
  });
}

export function updateSettings(changes: Record<string, unknown>): string[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Invalid settings body");
  const permitted = new Set(listSettings().map((x) => x.key));
  const entries = Object.entries(changes);
  const protectedRouting = /^(?:III_|AGENTMEMORY_(?:DATA_DIR|RUNTIME_DIR|URL|STATE_BACKEND|REDIS_URL|CAPTURE_SPOOL_DIR|PROJECT_CONTROLLER|SHARED_SETTINGS_FILE|LLM_LOCK_|LLM_SERIALIZE|METRICS_PORT)|STANDALONE_PERSIST_PATH)/;
  if (process.env["AGENTMEMORY_PROJECT_CONTROLLER"] && entries.some(([key]) => protectedRouting.test(key))) {
    throw new Error("Project routing and isolation settings are managed automatically.");
  }
  if (!entries.length || entries.length > 100) throw new Error("Specify 1–100 settings");
  for (const [key, value] of entries) {
    if (!permitted.has(key) || !KEY_PATTERN.test(key)) throw new Error(`Unknown setting: ${key}`);
    if (typeof value !== "string" || !validQueueSetting(key, value) || (key === "OPENAI_COMPRESSION_FORMAT" && !["", "xml", "json_schema"].includes(value)) || value.length > CUSTOM_VALUE_MAX ||
        /[\r\n\0"']/.test(value)) {
      throw new Error(`Invalid setting value: ${key}`);
    }
  }
  const path = settingsFilePath();
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing to overwrite symlinked config");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const original = envFileContent();
  const lines = original.split(/\r?\n/);
  const updated = new Set<string>();
  const next = lines.flatMap((line) => {
    const found = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (!found || !(found[1]! in changes)) return [line];
    const key = found[1]!;
    if (updated.has(key)) return [];
    updated.add(key);
    const value = changes[key] as string;
    return value ? [`${key}=${value}`] : [];
  });
  for (const [key, value] of entries) {
    if (!updated.has(key) && value !== "") next.push(`${key}=${value}`);
  }
  const out = next.join("\n").replace(/\n*$/, "\n");
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, out, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return entries.map(([key]) => key);
}

export function renderSettingsDocument(): { html: string; csp: string } {
  const path = rootCandidates("viewer/settings.html").find(existsSync);
  if (!path) throw new Error("Bundled settings.html is missing");
  const content = readFileSync(path, "utf8");
  const nonce = createViewerNonce();
  return { html: content.replaceAll(VIEWER_NONCE_PLACEHOLDER, nonce), csp: buildViewerCsp(nonce) };
}
