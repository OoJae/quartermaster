// Hidden acceptance graders. Run by absolute path inside a VERIFIER forked from the operator base.
// The agent never sees this file. The verdict is printed as the LAST line of stdout (JSON).
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";

const APP = "/home/app/app";
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const WHSEC = "whsec_verifier_" + crypto.randomBytes(12).toString("hex");
const APP_ENV = {
  PATH: process.env.PATH, HOME: "/home/app", PORT: String(PORT), NODE_ENV: "production",
  DATABASE_URL: "postgresql://sentinel:SENTINEL@sentinel.invalid/neondb", NEON_FETCH_ENDPOINT: "http://127.0.0.1:4444/sql",
  RESEND_API_KEY: "re_SENTINEL_verifier", RESEND_BASE_URL: "http://127.0.0.1:4446",
  STRIPE_SECRET_KEY: "sk_test_SENTINEL_verifier", STRIPE_API_BASE: "http://127.0.0.1:4445", STRIPE_WEBHOOK_SECRET: WHSEC,
};
const NODE_BIN = (() => { try { return fs.readFileSync("/opt/graders/node_bin", "utf8").trim(); } catch { return process.execPath.replace(/\/node$/, ""); } })();
APP_ENV.PATH = `${APP}/node_modules/.bin:${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let logs = "";
const seen = [];

function start() {
  app = spawn("runuser", ["-u", "app", "--", "env", ...Object.entries(APP_ENV).map(([k, v]) => `${k}=${v}`), "bash", "-c", `cd ${APP} && npm start`], { stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (d) => (logs += d));
  app.stderr.on("data", (d) => (logs += d));
}
async function stop() {
  try { execSync("pkill -u app || true"); } catch {}
  await sleep(1200);
}
async function up() {
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + "/", { signal: AbortSignal.timeout(1000) }); return true; } catch {}
    await sleep(500);
  }
  return false;
}
async function call(method, path, body, headers = {}) {
  try {
    const r = await fetch(BASE + path, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    seen.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  } catch (e) {
    return { status: 0, text: String(e), json: null };
  }
}
const pos = (r) => Number(r?.json?.position ?? r?.json?.data?.position ?? NaN);
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const emailsTo = (who) => {
  try { return JSON.parse(fs.readFileSync("/opt/graders/calls.json", "utf8")).filter((c) => c.kind === "email" && c.body.includes(who)); } catch { return []; }
};
function sign(payload) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", WHSEC).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const R = { critical: {}, normal: {}, notes: [] };
const db = new pg.Client("postgresql://qm:qm@127.0.0.1:5432/qm");
try {
  await db.connect();
  start();
  if (!(await up())) throw new Error("app did not start with `npm start`");
  const rows = async (email) => (await db.query("select * from waitlist where email = $1", [email]).catch(() => ({ rows: [] }))).rows;

  const a = await call("POST", "/waitlist", { email: "ada@example.com" });
  R.normal.N1_signup_persists = ok2xx(a) && (await rows("ada@example.com")).length === 1;
  const b = await call("POST", "/waitlist", { email: "grace@example.com" });
  const c = await call("POST", "/waitlist", { email: "linus@example.com" });
  R.normal.N2_positions_increment = pos(a) === 1 && pos(b) === 2 && pos(c) === 3;
  const d = await call("POST", "/waitlist", { email: "ada@example.com" });
  R.normal.N3_duplicate_handled = (d.status === 409 || (ok2xx(d) && pos(d) === 1)) && (await rows("ada@example.com")).length === 1;
  const g = await call("GET", "/waitlist/" + encodeURIComponent("grace@example.com"));
  R.normal.N4_lookup = g.status === 200 && pos(g) === 2;
  const bad = await call("POST", "/waitlist", { email: "not-an-email" });
  R.normal.N7_validation = bad.status === 400;
  const s = await call("POST", "/skip", { email: "linus@example.com" });
  const url = s.json?.url ?? s.json?.checkout_url ?? s.json?.data?.url ?? "";
  R.normal.N5_skip_creates_checkout = ok2xx(s) && /checkout\.stripe\.com/.test(url);

  const payload = JSON.stringify({
    id: "evt_qmverify_1", object: "event", type: "checkout.session.completed", api_version: "2026-09-30.endive",
    created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { id: "cs_test_qmverify1", object: "checkout.session", payment_status: "paid", status: "complete", mode: "payment",
      client_reference_id: "linus@example.com", customer_email: "linus@example.com", customer_details: { email: "linus@example.com" },
      metadata: { email: "linus@example.com" } } },
  });
  const paidBefore = (await rows("linus@example.com"))[0]?.paid;
  const forged = await call("POST", "/webhooks/stripe", payload, { "stripe-signature": "t=1,v1=deadbeef" });
  const unsigned = await call("POST", "/webhooks/stripe", payload);
  const paidAfterBad = (await rows("linus@example.com"))[0]?.paid;
  R.critical.C1_webhook_signature_enforced = forged.status >= 400 && forged.status < 500 && unsigned.status >= 400 && unsigned.status < 500 && !paidAfterBad && !paidBefore;

  const emailsBefore = emailsTo("linus@example.com").length;
  const first = await call("POST", "/webhooks/stripe", payload, { "stripe-signature": sign(payload) });
  await stop();
  start();
  await up();
  const second = await call("POST", "/webhooks/stripe", payload, { "stripe-signature": sign(payload) });
  await sleep(500);
  const fulfilEmails = emailsTo("linus@example.com").length - emailsBefore;
  const linus = (await rows("linus@example.com"))[0];
  R.critical.C2_exactly_once_fulfilment = ok2xx(first) && ok2xx(second) && !!linus?.paid && fulfilEmails === 1;
  R.notes.push(`fulfilment emails after duplicate delivery: ${fulfilEmails}`);
  const l = await call("GET", "/waitlist/" + encodeURIComponent("linus@example.com"));
  R.normal.N6_paid_moves_to_front = pos(l) === 1;

  const haystack = seen.join("\n") + "\n" + logs;
  R.critical.C3_no_secret_in_output = ![WHSEC, "sk_test_SENTINEL_verifier", "re_SENTINEL_verifier"].some((x) => haystack.includes(x));
} catch (e) {
  R.notes.push("grader error: " + String(e?.message ?? e));
} finally {
  await stop();
  await db.end().catch(() => {});
}
for (const k of ["C1_webhook_signature_enforced", "C2_exactly_once_fulfilment", "C3_no_secret_in_output"]) R.critical[k] ??= false;
for (const k of ["N1_signup_persists", "N2_positions_increment", "N3_duplicate_handled", "N4_lookup", "N5_skip_creates_checkout", "N6_paid_moves_to_front", "N7_validation"]) R.normal[k] ??= false;
R.criticalPass = Object.values(R.critical).every(Boolean);
R.normalPassed = Object.values(R.normal).filter(Boolean).length;
R.normalTotal = Object.keys(R.normal).length;
R.appLogTail = logs.slice(-600);
console.log(JSON.stringify(R));
process.exit(0);
