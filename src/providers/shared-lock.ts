import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

// Lock files are permanent rendezvous points: never unlink while workers run.
// A shared lock on the original file excludes old single-slot workers. A
// short configuration mutex prevents simultaneous use of different limits.
// Slot locks are released by the kernel on helper exit.
const helper = [
  "import fcntl, os, select, sys",
  "path, capacity = sys.argv[1], int(sys.argv[2])",
  "os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)",
  "def fd(name): return os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)",
  "def take(handle, mode):",
  "    try:",
  "        fcntl.flock(handle, mode | fcntl.LOCK_NB)",
  "        return True",
  "    except BlockingIOError: return False",
  "def wait():",
  "    if select.select([sys.stdin], [], [], 0.05)[0]: sys.exit(0)",
  "base = fd(path)",
  "while not take(base, fcntl.LOCK_SH): wait()",
  "mutex = fd(path + '.config')",
  "mine = fd(path + '.capacity-' + str(capacity))",
  "while True:",
  "    while not take(mutex, fcntl.LOCK_EX): wait()",
  "    compatible = True",
  "    for n in range(1, 17):",
  "        if n == capacity: continue",
  "        other = fd(path + '.capacity-' + str(n))",
  "        compatible = take(other, fcntl.LOCK_EX)",
  "        os.close(other)",
  "        if not compatible: break",
  "    if compatible: fcntl.flock(mine, fcntl.LOCK_SH)",
  "    fcntl.flock(mutex, fcntl.LOCK_UN)",
  "    if compatible: break",
  "    wait()",
  "while True:",
  "    slot = None",
  "    for n in range(capacity):",
  "        candidate = fd(path + '.slot-' + str(n))",
  "        if take(candidate, fcntl.LOCK_EX):",
  "            slot = candidate",
  "            break",
  "        os.close(candidate)",
  "    if slot is not None: break",
  "    wait()",
  "print('locked', flush=True)",
  "sys.stdin.buffer.read()",
].join("\n");

/** Host-wide generation semaphore (macOS/Linux); failures never bypass it. */
export async function withSharedLlmLock<T>(path: string, fn: () => Promise<T>, capacity = 1): Promise<T> {
  if (!isAbsolute(path)) throw new Error("AGENTMEMORY_LLM_LOCK_FILE must be absolute");
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16) throw new Error("Invalid LLM capacity");
  const child = spawn(process.env["AGENTMEMORY_LLM_LOCK_PYTHON"] || "python3",
    ["-u", "-c", helper, path, String(capacity)], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
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
