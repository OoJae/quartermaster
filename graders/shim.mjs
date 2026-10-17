// Offline Neon-compatible SQL-over-HTTP endpoint for the verifier, backed by local Postgres.
// The @neondatabase/serverless driver asks for raw text + array mode and parses types itself.
import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgresql://qm:qm@127.0.0.1:5432/qm", max: 8 });
const raw = { getTypeParser: () => (v) => v };

async function runOne(client, q) {
  const r = await client.query({ text: q.query, values: q.params ?? [], rowMode: "array", types: raw });
  const fields = (r.fields ?? []).map((f) => ({
    name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID ?? 0, columnID: f.columnID ?? 0,
    dataTypeSize: f.dataTypeSize ?? -1, dataTypeModifier: f.dataTypeModifier ?? -1, format: "text",
  }));
  return { fields, rows: r.rows ?? [], command: r.command, rowCount: r.rowCount, rowAsArray: true };
}

http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  let client;
  try {
    const j = JSON.parse(body || "{}");
    client = await pool.connect();
    let out;
    if (Array.isArray(j.queries)) {
      await client.query("BEGIN");
      const results = [];
      for (const q of j.queries) results.push(await runOne(client, q));
      await client.query("COMMIT");
      out = { results };
    } else {
      out = await runOne(client, j);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    try { await client?.query("ROLLBACK"); } catch {}
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: String(e?.message ?? e), code: e?.code, severity: e?.severity }));
  } finally {
    client?.release();
  }
}).listen(4444, "127.0.0.1");
