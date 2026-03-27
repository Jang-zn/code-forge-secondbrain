import PQueue from 'p-queue';

type Job = () => Promise<void>;

/**
 * Per-key debounce + global concurrency=1 queue.
 * When a key is triggered multiple times within debounceMs, only the last call runs.
 */
export class DebounceQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: PQueue;

  constructor(private debounceMs: number) {
    this.queue = new PQueue({ concurrency: 1 });
  }

  enqueue(key: string, job: Job): void {
    // Clear existing debounce timer for this key
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.queue.add(job).catch(() => {
        // errors handled inside job
      });
    }, this.debounceMs);

    this.timers.set(key, timer);
  }

  async drain(): Promise<void> {
    // Flush all pending timers immediately
    for (const [key, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    await this.queue.onIdle();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.queue.clear();
  }
}
