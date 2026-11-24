import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type RegisteredProject = { root: string; instance: number; dataDir: string };
type Action = "start" | "stop" | "restart";

export function projectControlEnabled(): boolean {
  const controller = process.env["AGENTMEMORY_PROJECT_CONTROLLER"];
  const python = process.env["AGENTMEMORY_LLM_LOCK_PYTHON"];
  return !!controller && !!python && isAbsolute(controller) && isAbsolute(python)
    && basename(controller) === "project-memory.py" && existsSync(controller) && existsSync(python);
}

export function registeredProjects(path = join(homedir(), ".agentmemory", "projects", "registry.json")): RegisteredProject[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid project registry");
  const slots = new Set<number>();
  const dirs = new Set<string>();
  return Object.entries(parsed).map(([root, entry]) => {
    if (!entry || typeof entry !== "object" || !isAbsolute(root)) throw new Error("Invalid project entry");
    const { instance, base } = entry as { instance?: unknown; base?: unknown };
    if (typeof instance !== "number" || !Number.isInteger(instance) || instance < 0 || instance > 50
        || typeof base !== "string" || !isAbsolute(base) || slots.has(instance)) throw new Error("Invalid project instance");
    const raw = instance ? join(base, `instance-${instance}`) : base;
    const dataDir = existsSync(raw) ? realpathSync(raw) : resolve(raw);
    if (dirs.has(dataDir)) throw new Error("Duplicate project storage");
    slots.add(instance);
    dirs.add(dataDir);
    return { root, instance, dataDir };
  }).sort((a, b) => a.instance - b.instance);
}

function restPort(project: RegisteredProject): number { return 3111 + project.instance * 100; }

function owned(project: RegisteredProject): boolean {
  const runtime = join(project.instance ? project.dataDir : join(homedir(), ".agentmemory"), "engine-state.json");
  try {
    const state = JSON.parse(readFileSync(runtime, "utf8"));
    if (state.kind !== "compose" || state.restPort !== restPort(project)
      || resolve(state.file) !== join(project.dataDir, "compose", "worker-compose.yaml")
      || resolve(state.stateDir) !== join(project.dataDir, "compose-state")
      || !Number.isSafeInteger(state.composePid) || state.composePid < 1) return false;
    process.kill(state.composePid, 0);
    return true;
  } catch { return false; }
}

async function sizeBytes(path: string): Promise<number | null> {
  if (!existsSync(path)) return 0;
  try {
    const { stdout } = await exec("du", ["-sk", path], { timeout: 4000, maxBuffer: 4096 });
    const kib = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
  } catch { return null; }
}

async function inspect(project: RegisteredProject, secret?: string) {
  const rest = restPort(project);
  const url = `http://127.0.0.1:${rest}`;
  let state: "running" | "stopped" | "unreachable" | "unverified" = "stopped";
  let queue: { pending: number; running: number; exhausted: number } | null = null;
  try {
    const response = await fetch(`${url}/agentmemory/livez`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    state = response.ok ? (owned(project) ? "running" : "unverified") : "unreachable";
    await response.body?.cancel();
    if (state === "running" && secret) {
      const r = await fetch(`${url}/agentmemory/compression/queue`, {
        headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2000), redirect: "error",
      });
      if (r.ok) {
        const value = await r.json() as Record<string, unknown>;
        if (["pending", "running", "exhausted"].every(k => typeof value[k] === "number" && Number.isSafeInteger(value[k]) && Number(value[k]) >= 0)) {
          queue = { pending: Number(value.pending), running: Number(value.running), exhausted: Number(value.exhausted) };
        }
      } else await r.body?.cancel();
    }
  } catch { if (owned(project)) state = "unreachable"; }
  return { ...project, name: basename(project.root), state, queue, sizeBytes: await sizeBytes(project.dataDir),
    restPort: rest, viewer: `http://127.0.0.1:${rest + 2}/viewer` };
}

export async function listProjectInstances(secret?: string) {
  if (!projectControlEnabled()) return { enabled: false, projects: [] };
  const projects = registeredProjects();
  const results: Awaited<ReturnType<typeof inspect>>[] = [];
  for (let i = 0; i < projects.length; i += 4) {
    results.push(...await Promise.all(projects.slice(i, i + 4).map(p => inspect(p, secret))));
  }
  return { enabled: true, projects: results };
}

/** Start a controller operation in its own process group so stopping the
 * current Viewer does not kill the controller before it finishes. */
export async function requestProjectAction(instance: unknown, action: unknown): Promise<void> {
  if (!projectControlEnabled()) throw new Error("Project control is not configured.");
  if (typeof instance !== "number" || !["start", "stop", "restart"].includes(String(action))) throw new Error("Invalid project action");
  const project = registeredProjects().find(p => p.instance === instance);
  if (!project) throw new Error("Unknown project instance");
  const operation = action as Action;
  const logs = join(homedir(), ".agentmemory", "projects", "actions");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const output = openSync(join(logs, `instance-${project.instance}.log`), "a", 0o600);
  try {
    const env: NodeJS.ProcessEnv = {
      HOME: homedir(),
      PATH: process.env["PATH"] || "/usr/local/bin:/usr/bin:/bin",
      AGENTMEMORY_ENV_FILE: process.env["AGENTMEMORY_SHARED_SETTINGS_FILE"] || join(homedir(), ".agentmemory", ".env"),
    };
    const child = spawn(process.env["AGENTMEMORY_LLM_LOCK_PYTHON"]!, [
      process.env["AGENTMEMORY_PROJECT_CONTROLLER"]!, "--project", project.root, operation,
    ], { detached: true, stdio: ["ignore", output, output], env });
    await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    child.unref();
  } finally { closeSync(output); }
}
