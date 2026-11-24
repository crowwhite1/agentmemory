import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

// POSIX flock is released by the kernel if the helper exits (including when
// its parent dies and stdin closes). Never delete a lock file while in use.
const helper = [
  "import fcntl, os, sys",
  "path = sys.argv[1]",
  "os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)",
  "fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)",
  "fcntl.flock(fd, fcntl.LOCK_EX)",
  "print('locked', flush=True)",
  "sys.stdin.buffer.read()",
].join("\n");

/** Opt-in host-wide gate for workers sharing a local model (macOS/Linux).
 * Failure to acquire the lock fails the operation, never bypasses the gate.
 */
export async function withSharedLlmLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  if (!isAbsolute(path)) throw new Error("AGENTMEMORY_LLM_LOCK_FILE must be absolute");
  const child = spawn(process.env["AGENTMEMORY_LLM_LOCK_PYTHON"] || "python3",
    ["-u", "-c", helper, path], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
  // A terminated helper may close its pipe before the parent releases it.
  child.stdin.on("error", () => {});
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", chunk => {
        output += String(chunk);
        if (output.includes("locked\n")) resolve();
      });
      child.once("error", reject);
      child.once("close", code => reject(new Error(
        `Shared LLM lock helper exited (${code}): ${stderr}`,
      )));
    });
    return await fn();
  } finally {
    child.stdin.end();
    await exited;
  }
}
