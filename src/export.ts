// Export Run Cards to docs/ for static hosting (GitHub Pages): pnpm tsx src/export.ts
import { readdirSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { readRun, verifyChain } from "./runcard.js";

mkdirSync("docs/runs", { recursive: true });
copyFileSync("web/run.html", "docs/run.html");
// public read-only dashboard replay (no broker, no keys): same UI, reads exported Run Cards
writeFileSync("docs/dashboard.html", readFileSync("web/index.html", "utf8").replace("<script>", "<script>window.QM_STATIC = true;</script>\n<script>"));
const index: any[] = [];
const jobs = (existsSync("runs") ? readdirSync("runs") : []).filter((f) => f.startsWith("job-") && f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));
const rows: string[] = [];
for (const job of jobs.sort().reverse()) {
  const events = readRun(job);
  if (!events.some((e) => e.kind === "stripe.captured" || e.kind === "stripe.released")) continue;
  writeFileSync(`docs/runs/${job}.json`, JSON.stringify({ job, events, chainBrokenAt: verifyChain(events), head: events.at(-1)?.hash }));
  const cap = events.find((e) => e.kind === "stripe.captured")?.data as any;
  const ver = events.find((e) => e.kind === "verifier.verdict")?.data as any;
  const fixture = (events[0]?.data as any)?.fixture;
  index.push({ job, status: cap ? "captured" : "released", captured: cap ? cap.amount_received : 0, started: events[0]?.ts });
  rows.push(`<tr><td><a href="run.html?job=${job}">${job}</a> · <a href="dashboard.html?replay=${job}&speed=30">dashboard replay ▶</a></td><td>${fixture ? "reference build (" + fixture + ")" : "agent build"}</td><td>${ver ? (ver.criticalPass ? "critical ✓" : "critical ✗") + " · " + ver.normalPassed + "/" + ver.normalTotal : "–"}</td><td>${cap ? "$" + (cap.amount_received / 100).toFixed(2) + " captured" : "$0 · hold released"}</td><td>${verifyChain(events) === -1 ? "intact" : "broken"}</td></tr>`);
}
writeFileSync("docs/runs/index.json", JSON.stringify(index));
writeFileSync("docs/index.html", `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quartermaster: Run Cards</title>
<style>body{margin:0;background:#0b0d12;color:#e7e9ee;font:15px/1.5 system-ui}main{max-width:980px;margin:0 auto;padding:32px 18px}h1{margin:0}p{color:#8b93a7}table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border-bottom:1px solid #232836;padding:10px 6px;text-align:left}a{color:#7c9cff}code{color:#c3a6ff}</style></head>
<body><main><h1>Quartermaster</h1><p>Hire a coding agent like a contractor: it never holds your keys, requisitions infrastructure through Stripe Projects, works in a CreateOS microVM that can reach one thing, and is paid (Stripe manual capture) only when hidden tests pass on a sealed verifier. Every run below is a hash-chained Run Card you can verify in your browser, and each agent run can be replayed in the operator dashboard.</p><p><a href="dashboard.html?replay=${index.find((r) => !r.job.includes("fixture"))?.job ?? ""}&speed=30">▶ Watch the latest agent run in the dashboard</a></p>
<table><tr><th>Run</th><th>Build</th><th>Hidden checks</th><th>Payment</th><th>Chain</th></tr>${rows.join("")}</table>
<p>Source: <a href="https://github.com/OoJae/quartermaster">github.com/OoJae/quartermaster</a></p></main></body></html>`);
console.log(`exported ${rows.length} run cards to docs/`);
