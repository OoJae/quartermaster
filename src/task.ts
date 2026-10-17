// The job the client posts and authorizes $49 for. The hidden graders check exactly these stated requirements.
export const TASK = `Build a waitlist API with a paid "skip the line" option, in /workspace/app.

Requirements (Node 24, plain JavaScript ESM or TypeScript run via tsx; \`npm start\` must start the server on $PORT):
1. On startup, create the table if it does not exist:
   waitlist(email text primary key, paid boolean not null default false, paid_at timestamptz, created_at timestamptz not null default now())
   plus any table you need to record processed Stripe events.
2. Position is computed, not stored: paid signups first (by paid_at), then unpaid by created_at, 1-based.
3. POST /waitlist {email}  -> 201 {email, position}. Invalid email -> 400. Duplicate email -> 409.
   After a successful signup, send a confirmation email to that address.
4. GET /waitlist/:email  -> 200 {email, position, paid}, or 404.
5. POST /skip {email}  -> create a Stripe Checkout Session (mode=payment, one line item "Skip the line", USD 500 cents,
   metadata[email]=<email>, client_reference_id=<email>, success_url/cancel_url of your choice) and return 200 {url}.
6. POST /webhooks/stripe  -> verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET using the RAW request body
   (reject missing/invalid signatures with 400). On checkout.session.completed, mark that email paid (from metadata.email)
   and send a "You skipped the line" email. Stripe may deliver the same event more than once, including after a restart,
   so fulfilment (marking paid + the email) must happen exactly once per checkout session. Respond 200 {received:true}.

How to reach services (this machine has no other network access):
- Postgres: \`@neondatabase/serverless\`. Set neonConfig.fetchEndpoint = process.env.NEON_FETCH_ENDPOINT, then
  const sql = neon(process.env.DATABASE_URL) and use tagged-template queries.
- Email: POST \${RESEND_BASE_URL}/emails with header Authorization: Bearer \${RESEND_API_KEY} and JSON
  {from: "onboarding@resend.dev", to: [email], subject, html}.
- Stripe: POST \${STRIPE_API_BASE}/v1/checkout/sessions, form-encoded, header Authorization: Bearer \${STRIPE_SECRET_KEY}.
  For webhook verification you may use the \`stripe\` package's webhooks.constructEvent (it needs no network) or HMAC-SHA256 yourself.
- npm installs work normally (registry is preconfigured).
`;
