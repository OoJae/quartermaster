// Offline stand-ins for Stripe (4445) and Resend (4446) inside the verifier. Every call is recorded.
import http from "node:http";
import fs from "node:fs";

const calls = [];
const record = () => fs.writeFileSync("/opt/graders/calls.json", JSON.stringify(calls));

function serve(port, kind, handler) {
  http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    calls.push({ t: Date.now(), kind, method: req.method, url: req.url, body: b.slice(0, 4000) });
    record();
    handler(req, res, b);
  }).listen(port, "127.0.0.1");
}

let n = 0;
serve(4445, "stripe", (req, res, b) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url.startsWith("/v1/checkout/sessions")) {
    n++;
    const p = new URLSearchParams(b);
    const metadata = {};
    for (const [k, v] of p) {
      const m = k.match(/^metadata\[(.+)\]$/);
      if (m) metadata[m[1]] = v;
    }
    const id = `cs_test_qmverify${n}`;
    return res.end(JSON.stringify({
      id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}`, mode: p.get("mode") ?? "payment",
      metadata, client_reference_id: p.get("client_reference_id"), customer_email: p.get("customer_email"),
      payment_status: "unpaid", status: "open", livemode: false,
    }));
  }
  res.end(JSON.stringify({ id: "obj_qmverify", object: "unknown", livemode: false }));
});

serve(4446, "email", (_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: `email_qmverify_${Date.now()}` }));
});
