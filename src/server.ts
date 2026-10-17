import express from "express";
import { readdirSync, existsSync } from "node:fs";
import { env } from "./env.js";
import { bus, readRun, verifyChain, type RunEvent } from "./runcard.js";
import { approvals } from "./requisition.js";
import { runJob } from "./job.js";

const app = express();
app.use(express.json());
app.use(express.static("web"));

const running = new Set<string>();

app.post("/api/jobs", (req, res) => {
  const job = `job-${Date.now().toString(36)}`;
  running.add(job);
  runJob(job, { keepSite: !!req.body?.keepSite })
    .catch((e) => console.error(job, "failed:", e?.message))
    .finally(() => running.delete(job));
  res.json({ job });
});

app.get("/api/jobs", (_req, res) => {
  const files = existsSync("runs") ? readdirSync("runs").filter((f) => f.startsWith("job-") && f.endsWith(".jsonl")) : [];
  const jobs = files.map((f) => {
    const job = f.replace(/\.jsonl$/, "");
    const evs = readRun(job);
    const cap = evs.find((e) => e.kind === "stripe.captured")?.data as any;
    const rel = evs.find((e) => e.kind === "stripe.released")?.data as any;
    const status = cap ? "captured" : rel ? "released" : running.has(job) ? "running" : evs.some((e) => e.kind === "job.error") ? "error" : evs.some((e) => e.kind === "job.done") ? "done" : "incomplete";
    return { job, events: evs.length, running: running.has(job), started: evs[0]?.ts, captured: cap ? cap.amount_received : rel ? 0 : null, status };
  }).sort((a, b) => String(b.started).localeCompare(String(a.started)));
  res.json(jobs);
});

app.get("/api/runs/:job", (req, res) => {
  const evs = readRun(req.params.job);
  res.json({ job: req.params.job, events: evs, chainBrokenAt: verifyChain(evs), head: evs.at(-1)?.hash ?? null });
});

app.post("/api/requisitions/:id/:decision", (req, res) => {
  approvals.emit(req.params.id, req.params.decision === "approve");
  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const job = String(req.query.job ?? "");
  if (job) for (const ev of readRun(job)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const on = (ev: RunEvent) => { if (!job || ev.job === job) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  bus.on("event", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { bus.off("event", on); clearInterval(ping); });
});

app.get("/run/:job", (_req, res) => res.sendFile("run.html", { root: "web" }));

app.listen(env.port, () => console.log(`Quartermaster broker on http://localhost:${env.port}`));
