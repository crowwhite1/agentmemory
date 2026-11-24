import type { MemoryProvider } from "../types.js";
import { withSharedLlmLock } from "./shared-lock.js";
import { readCompressionQueueSettings } from "../functions/compression-queue-config.js";

/** Bounded local FIFO with a shared host-wide generation semaphore. */
export class SerializedMemoryProvider implements MemoryProvider {
  readonly name: string;
  declare readonly describeImage?: MemoryProvider["describeImage"];
  private closed = false;
  private processing = 0;
  private readonly queue: Array<() => void> = [];
  private readonly capacity = readCompressionQueueSettings().llmConcurrency;
  private readonly lock = process.env["AGENTMEMORY_LLM_LOCK_FILE"];

  constructor(private readonly inner: MemoryProvider) {
    this.name = `serialized(${inner.name})`;
    if (typeof inner.describeImage === "function") {
      this.describeImage = (data, mime, prompt) =>
        this.one(() => inner.describeImage!(data, mime, prompt));
    }
  }

  private pump(): void {
    while (this.processing < this.capacity && this.queue.length) {
      this.processing++;
      this.queue.shift()!();
    }
  }

  private one(fn: () => Promise<string>): Promise<string> {
    if (this.closed) return Promise.reject(new Error("provider_shutdown"));
    return new Promise<string>((resolve, reject) => {
      this.queue.push(() => {
        void Promise.resolve().then(() =>
          this.lock ? withSharedLlmLock(this.lock, fn, this.capacity) : fn()
        ).then(resolve, reject).finally(() => {
          this.processing--;
          this.pump();
        });
      });
      this.pump();
    });
  }

  compress(system: string, user: string): Promise<string> {
    return this.one(() => this.inner.compress(system, user));
  }
  summarize(system: string, user: string): Promise<string> {
    return this.one(() => this.inner.summarize(system, user));
  }
  get status(): { active: number; pending: number } {
    return { active: this.processing, pending: this.queue.length };
  }
  close(): void { this.closed = true; }
}
