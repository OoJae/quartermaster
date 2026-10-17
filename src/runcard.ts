import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";

// The Run Card: a host-authored, hash-chained record of everything a job did.
// CreateOS only audits control-plane actions, so in-sandbox activity is recorded here.

export type RunEvent = {
  seq: number;
  ts: string;
  job: string;
  kind: string; // e.g. vm.create, egress.set, tool.run_command, requisition.quote, stripe.capture
  data: Record<string, unknown>;
  prev: string;
  hash: string;
};

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const SECRET_PATTERNS = [/sk_(test|live)_[A-Za-z0-9]{10,}/g, /rk_(test|live)_[A-Za-z0-9]{10,}/g, /re_[A-Za-z0-9]{20,}/g, /npg_[A-Za-z0-9]{8,}/g, /sk-ant-[A-Za-z0-9-_]{10,}/g, /skp_[A-Za-z0-9]{10,}/g, /whsec_[A-Za-z0-9]{10,}/g];
const realSecrets: string[] = [];

/** Register real secret values so they are scrubbed (fail-closed) from everything we record or show the model. */
export function registerSecret(v?: string) {
  if (v && v.length >= 8 && !realSecrets.includes(v)) realSecrets.push(v);
}
export function scrub(s: string): string {
  let out = s;
  for (const v of realSecrets) out = out.split(v).join("[redacted]");
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m) => (m.includes("SENTINEL") ? m : "[redacted]"));
  return out;
}

export class RunCard {
  private seq = 0;
  private prev = "genesis";
  readonly file: string;
  constructor(readonly job: string) {
    mkdirSync("runs", { recursive: true });
    this.file = `runs/${job}.jsonl`;
  }
  add(kind: string, data: Record<string, unknown> = {}): RunEvent {
    const clean = JSON.parse(scrub(JSON.stringify(data)));
    const body = { seq: ++this.seq, ts: new Date().toISOString(), job: this.job, kind, data: clean, prev: this.prev };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const ev: RunEvent = { ...body, hash };
    this.prev = hash;
    appendFileSync(this.file, JSON.stringify(ev) + "\n");
    bus.emit("event", ev);
    return ev;
  }
  get head() {
    return this.prev;
  }
}

export function readRun(job: string): RunEvent[] {
  const f = `runs/${job}.jsonl`;
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Recompute the chain; returns the index of the first broken link, or -1 if intact. */
export function verifyChain(events: RunEvent[]): number {
  let prev = "genesis";
  for (let i = 0; i < events.length; i++) {
    const { hash, ...body } = events[i];
    if (body.prev !== prev) return i;
    const h = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (h !== hash) return i;
    prev = hash;
  }
  return -1;
}
