// Show the broker's policy firing on out-of-policy requisitions (no VMs needed): pnpm tsx src/policydemo.ts
import { RunCard, bus } from "./runcard.js";
import { Broker } from "./requisition.js";

bus.on("event", (e) => console.log(`#${e.seq} ${e.kind} ${JSON.stringify(e.data).slice(0, 200)}`));
const card = new RunCard(`job-policy-${Date.now().toString(36)}`);
card.add("job.start", { job: card.job, purpose: "policy guardrails demo: out-of-policy requisitions are refused deterministically, before any provisioning" });
const site = { caps: new Set() } as any; // denial happens before the site is touched
const broker = new Broker(card, site);
console.log(await broker.requisition({ capability: "database", reason: "Bigger database for load tests", tier: "launch" }));
console.log(await broker.requisition({ capability: "gpu", reason: "Fine-tune a model" }));
card.add("job.done", { denied: 2, provisioned: 0 });
process.exit(0);
