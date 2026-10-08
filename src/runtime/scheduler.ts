// In-process scheduler with a single-worker queue: exactly one run at a time (one SQLite writer, one local GPU).
import { dueEntries, type ScheduleEntry } from './schedule.js';

export type Trigger = 'scheduler' | 'console';
export interface QueueItem { id: string; trigger: Trigger; runId?: string }

export interface SchedulerDeps {
  entries: () => ScheduleEntry[];
  lastStarted: () => Record<string, string>;
  markStarted: (id: string, iso: string) => void;
  run: (item: QueueItem) => Promise<void>;
  /** SCHEDULER_PAUSED: nothing is scheduled and manual triggers are refused. */
  paused?: boolean;
  now?: () => Date;
}

export class Scheduler {
  private queue: QueueItem[] = [];
  private running: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(private deps: SchedulerDeps) {}

  private now(): Date { return (this.deps.now ?? (() => new Date()))(); }

  private enqueue(item: QueueItem): boolean {
    if (this.running === item.id || this.queue.some((i) => i.id === item.id)) return false;
    this.queue.push(item);
    return true;
  }

  tick(): void {
    if (this.stopped || this.deps.paused) return;
    for (const e of dueEntries(this.deps.entries(), this.deps.lastStarted(), this.now())) {
      this.enqueue({ id: e.id, trigger: 'scheduler' });
    }
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.stopped) return;
        const item = this.queue.shift();
        if (!item) return;
        this.running = item.id;
        try {
          // Claimed now: not due again until its next tick; a manual run suppresses that tick's scheduled duplicate.
          this.deps.markStarted(item.id, this.now().toISOString());
          await this.deps.run(item);
          console.log(JSON.stringify({ event: 'run_finished', id: item.id, trigger: item.trigger }));
        } catch (e) {
          console.error(JSON.stringify({ event: 'run_failed', id: item.id, trigger: item.trigger, error: e instanceof Error ? e.message : String(e) }));
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Console-triggered run. Returns why it was not queued, if it was not. */
  enqueueManual(id: string, runId?: string): { queued: boolean; reason?: 'paused' | 'stopping' | 'duplicate' } {
    if (this.deps.paused) return { queued: false, reason: 'paused' };
    if (this.stopped) return { queued: false, reason: 'stopping' };
    if (!this.enqueue({ id, trigger: 'console', runId })) return { queued: false, reason: 'duplicate' };
    void this.drain();
    return { queued: true };
  }

  start(intervalMs = 60_000): void {
    if (this.deps.paused) {
      console.warn(JSON.stringify({ event: 'scheduler_paused', note: 'SCHEDULER_PAUSED is set: no scheduled or manual run will start' }));
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    const loop = async (): Promise<void> => {
      try { this.tick(); await this.drain(); } catch (e) {
        console.error(JSON.stringify({ event: 'scheduler_loop_error', error: e instanceof Error ? e.message : String(e) }));
      }
    };
    void loop();
    this.timer = setInterval(() => void loop(), intervalMs);
  }

  /** The current run finishes; nothing new starts. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): { running: string | null; queued: QueueItem[]; paused: boolean } {
    return { running: this.running, queued: [...this.queue], paused: !!this.deps.paused };
  }
}
