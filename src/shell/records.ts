/**
 * The interface's view of the records table: loaded once, kept current by change events
 * (which carry IDs and sequence numbers, never bodies).
 */
import { call, on } from "../backend";
import { signal } from "../kit/signal";
import type { Change } from "../generated/Change";
import type { RecordInfo } from "../generated/RecordInfo";

export class Records {
  /** Every record, by ID. Replaced (not mutated) on each change. */
  readonly byId = signal<Map<string, RecordInfo>>(new Map());
  /** The highest change sequence number applied. */
  readonly seq = signal(0);
  private waiters: { seq: number; resolve: () => void }[] = [];

  /** `hiding()` names fields that hide a record from lists (shell.hiding-fields). */
  constructor(readonly hiding: () => string[] = () => []) {
    on("event.change", (p) => void this.apply(p as Change));
  }

  async load(): Promise<void> {
    try {
      const list = await call<RecordInfo[]>("records.list", {});
      this.byId.set(new Map(list.map((r) => [r.id, r])));
    } catch {
      this.byId.set(new Map());
    }
  }

  /** Records of a kind (or all), leaving out hidden ones (e.g. archived) unless asked. */
  list(kind?: string, opts: { hidden?: boolean } = {}): RecordInfo[] {
    const all = [...this.byId().values()];
    const hide = opts.hidden ? [] : this.hiding();
    return all.filter((r) => (!kind || r.kind === kind) && !hide.some((f) => r.fields[f] != null));
  }

  /** Whether a record is hidden from lists (e.g. archived). */
  isHidden(r: RecordInfo): boolean {
    return this.hiding().some((f) => r.fields[f] != null);
  }

  get(id: string): RecordInfo | undefined {
    return this.byId().get(id);
  }

  /** Records a write's result at once (the window shows its own edits). */
  put(r: RecordInfo, seq?: number): void {
    const m = new Map(this.byId.peek());
    m.set(r.id, r);
    this.byId.set(m);
    if (seq) this.advance(seq);
  }

  /** Resolves once changes up to `seq` are applied. */
  waitFor(seq: number): Promise<void> {
    if (this.seq.peek() >= seq) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ seq, resolve }));
  }

  private async apply(c: Change): Promise<void> {
    if (c.op === "removed") {
      const m = new Map(this.byId.peek());
      m.delete(c.id);
      this.byId.set(m);
    } else {
      try {
        const r = await call<RecordInfo>("records.get", { id: c.id });
        const m = new Map(this.byId.peek());
        m.set(r.id, r);
        this.byId.set(m);
      } catch {
        /* gone again */
      }
    }
    this.advance(c.seq);
  }

  private advance(seq: number): void {
    if (seq > this.seq.peek()) this.seq.set(seq);
    const ready = this.waiters.filter((w) => w.seq <= seq);
    this.waiters = this.waiters.filter((w) => w.seq > seq);
    for (const w of ready) w.resolve();
  }
}
