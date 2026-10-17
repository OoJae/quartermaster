// Reference implementation used to validate the grader pack (operator fixture, not agent output).
import http from "node:http";
import crypto from "node:crypto";
import { neon, neonConfig } from "@neondatabase/serverless";

const BUGGY = true;
neonConfig.fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
const sql = neon(process.env.DATABASE_URL);
await sql`create table if not exists waitlist (email text primary key, paid boolean not null default false, paid_at timestamptz, created_at timestamptz not null default now())`;
await sql`create table if not exists processed_sessions (session_id text primary key, created_at timestamptz not null default now())`;

const send = (to, subject) => fetch(`${process.env.RESEND_BASE_URL}/emails`, { method: "POST", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from: "onboarding@resend.dev", to: [to], subject, html: `<p>${subject}</p>` }) }).catch(() => {});
const position = async (email) => (await sql`select email, paid, rn from (select email, paid, row_number() over (order by paid desc, paid_at asc nulls last, created_at asc) as rn from waitlist) t where email = ${email}`)[0];
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/waitlist") {
      const { email } = JSON.parse(raw || "{}");
      if (!email || !EMAIL.test(email)) return json(res, 400, { error: "invalid email" });
      const ins = await sql`insert into waitlist (email) values (${email}) on conflict do nothing returning email`;
      if (!ins.length) return json(res, 409, { error: "duplicate" });
      await send(email, "You are on the waitlist");
      return json(res, 201, { email, position: Number((await position(email)).rn) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/waitlist/")) {
      const email = decodeURIComponent(url.pathname.slice("/waitlist/".length));
      const p = await position(email);
      return p ? json(res, 200, { email, position: Number(p.rn), paid: p.paid }) : json(res, 404, { error: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/skip") {
      const { email } = JSON.parse(raw || "{}");
      const body = new URLSearchParams({ mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": "500", "line_items[0][price_data][product_data][name]": "Skip the line", success_url: "https://example.com/ok", cancel_url: "https://example.com/cancel", "metadata[email]": email, client_reference_id: email });
      const r = await fetch(`${process.env.STRIPE_API_BASE}/v1/checkout/sessions`, { method: "POST", headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" }, body });
      return json(res, 200, { url: (await r.json()).url });
    }
    if (req.method === "POST" && url.pathname === "/webhooks/stripe") {
      if (!BUGGY) {
        const parts = Object.fromEntries(String(req.headers["stripe-signature"] ?? "").split(",").map((kv) => kv.split("=")));
        const expected = crypto.createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${raw}`).digest("hex");
        if (!parts.v1 || parts.v1.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))) return json(res, 400, { error: "bad signature" });
      }
      const evt = JSON.parse(raw);
      if (evt.type === "checkout.session.completed") {
        const s = evt.data.object;
        const first = BUGGY ? [s.id] : await sql`insert into processed_sessions (session_id) values (${s.id}) on conflict do nothing returning session_id`;
        if (first.length) {
          await sql`update waitlist set paid = true, paid_at = now() where email = ${s.metadata?.email}`;
          await send(s.metadata?.email, "You skipped the line");
        }
      }
      return json(res, 200, { received: true });
    }
    if (url.pathname === "/") return json(res, 200, { ok: true });
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: "internal" });
  }
}).listen(Number(process.env.PORT ?? 3000));
