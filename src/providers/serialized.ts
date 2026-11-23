import type { MemoryProvider } from "../types.js";

/** Limit all calls using the same provider to one in-flight LM Studio generation.
 * New compression and summary work share this gate, rather than racing
 * independently in the upstream model. The gate is intentionally process-local.
 */
export class SerializedMemoryProvider implements MemoryProvider {
  readonly name: string;
  declare readonly describeImage?: MemoryProvider["describeImage"];
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private waiting = 0;
  private processing = 0;

  constructor(private readonly inner: MemoryProvider) {
    this.name = `serialized(${inner.name})`;
    if (typeof inner.describeImage === "function") {
      this.describeImage = (data, mime, prompt) =>
        this.one(() => inner.describeImage!(data, mime, prompt));
    }
  }

  private one(fn: () => Promise<string>): Promise<string> {
    if (this.closed) return Promise.reject(new Error("provider_shutdown"));
    this.waiting++;
    const run = this.tail.then(async () => {
      this.waiting--;
      this.processing++;
      try { return await fn(); }
      finally { this.processing--; }
    });
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  compress(system: string, user: string): Promise<string> {
    return this.one(() => this.inner.compress(system, user));
  }
  summarize(system: string, user: string): Promise<string> {
    return this.one(() => this.inner.summarize(system, user));
  }
  get status(): { active: number; pending: number } {
    return { active: this.processing, pending: this.waiting };
  }
  close(): void { this.closed = true; }
}
