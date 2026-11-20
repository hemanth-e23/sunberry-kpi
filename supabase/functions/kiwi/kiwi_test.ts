// Run: KIWI_DB_URL=... deno test -A kiwi_test.ts
function assert(c: unknown, msg = "assertion failed"): asserts c { if (!c) throw new Error(msg); }
const assertEquals = (a: unknown, b: unknown) => assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const assertStringIncludes = (a: string, b: string) => assert(a.includes(b), `"${a.slice(0, 200)}" lacks "${b}"`);
import { guardSql } from "./sql_guard.ts";

const ok = (s: string, people = false) => guardSql(s, { allowPeople: people }).ok;

Deno.test("guard allows normal reads", () => {
  assert(ok("select sum(cases_produced) from shift_line_summary where line = 2"));
  assert(ok("with x as (select 1) select * from x;"));
  assert(ok("select * from shift_downtime where reason ilike '%lock nut%' or reason ilike '%call%'"));
  assert(ok("select 'a;b' as t"));
});

Deno.test("guard blocks writes, other schemas, multiple statements", () => {
  for (const s of [
    "delete from shift_notes", "update kiwi.shift_notes set x=1", "select 1; drop table x",
    "select * from plant.shift_production", "select * from public.comments", "select * from auth.users",
    "select pg_sleep(30)", "select 1 -- hi", "insert into x values (1)", "copy x to '/tmp/a'",
    "select * from \"public\".comments", "select 'unbalanced",
    "select query_to_xml('select name from shift_people', true, false, '')", "select schema_to_xml('kiwi',true,false,'')",
    "select set_config('role','kiwi_manager_reader',false)", "select * from U&\"shift\\005fpeople\"",
  ]) assert(!ok(s), s);
});

Deno.test("guard hides absence names unless allowed", () => {
  assert(!ok("select name from shift_people"));
  assert(ok("select name from shift_people", true));
});

Deno.test("guard caps rows", () => {
  const g = guardSql("select * from shift_downtime", { allowPeople: false });
  assert(g.ok && g.sql.endsWith("limit $1"));
});

// ---- end to end with a stand-in AI and the local test database ----
Deno.test({
  name: "question -> SQL -> answer loop",
  ignore: !Deno.env.get("KIWI_DB_URL"),
  sanitizeResources: false, sanitizeOps: false,
  fn: async () => {
    const seen: unknown[] = [];
    let call = 0;
    const server = Deno.serve({ port: 8787, onListen() {} }, async (req) => {
      const body = await req.json();
      seen.push(body);
      call++;
      if (call === 1) {
        // first: a forbidden query, KIWI should get an error back
        return Response.json({ stop_reason: "tool_use", content: [
          { type: "tool_use", id: "t1", name: "run_sql", input: { sql: "select * from plant.shift_notes" } }] });
      }
      if (call === 4) return Response.json({ stop_reason: "max_tokens", content: [] });   // empty reply
      if (call === 5) return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "recovered" }] });
      if (call === 2) {
        return Response.json({ stop_reason: "tool_use", content: [
          { type: "tool_use", id: "t2", name: "run_sql", input: { sql:
            "select line, sum(cases_produced) cases, sum(reported_downtime_minutes) dt from shift_line_summary where report_date = '2026-11-03' group by line order by line" } }] });
      }
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "done" }] });
    });
    Deno.env.set("KIWI_AI_URL", "http://localhost:8787/");
    Deno.env.set("ANTHROPIC_API_KEY", "test");
    const { answer } = await import("./index.ts");
    const text = await answer("How did Nov 3 go?", [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello" }],
      { role: "viewer", label: "test" });
    assertEquals(text, "done");
    const third = seen[2] as { messages: { role: string; content: { content: string }[] }[]; system: unknown };
    const results = third.messages.filter((m) => m.role === "user" && Array.isArray(m.content));
    assertStringIncludes(results[0].content[0].content, "error");
    const rows = JSON.parse(results[1].content[0].content).rows;
    console.log("Nov 3 from DB:", JSON.stringify(rows));
    assertEquals(rows.length, 2);
    const sys = JSON.stringify(third.system);
    assertStringIncludes(sys, "may NOT see absence");
    assertStringIncludes(sys, '"cache_control":{"type":"ephemeral"}');
    assertEquals(third.messages[0], { role: "user", content: "hi" });
    // second question: AI returns nothing once, KIWI asks again and gets an answer
    const again = await answer("batches yesterday line 1?", [], { role: "manager", label: "test" });
    assertEquals(again, "recovered");
    assertStringIncludes(JSON.stringify((seen[4] as { messages: unknown }).messages), "give your answer now");
    assertStringIncludes(JSON.stringify((seen[3] as { system: unknown }).system), "MAY see absence");
    await server.shutdown();
  },
});

Deno.test({
  name: "database enforces names + one statement",
  ignore: !Deno.env.get("KIWI_MANAGER_DB_URL"),
  sanitizeResources: false, sanitizeOps: false,
  fn: async () => {
    const { runQuery } = await import("./index.ts");
    // a normal user: even if the text check were bypassed, the database says no
    const viaDb = await runQuery("select count(*) n from shift_people", true);   // manager login
    assertStringIncludes(viaDb, '"row_count":1');
    const blocked = await runQuery("select count(*) n from shift_people", false);
    assertStringIncludes(blocked, "error");
    const postgres = (await import("npm:postgres@3.4.5")).default;
    const db = postgres(Deno.env.get("KIWI_DB_URL")!, { max: 1, prepare: false });
    let multi = "";
    try { await db.unsafe("select * from (select 1) t limit $1; select 2", [200]); } catch (e) { multi = String(e); }
    await db.end();
    assertStringIncludes(multi, "multiple commands");
    // and an injection attempt that slips a second statement in via the wrapper
    const inj = await runQuery("select 1) x; select name from shift_people; select (1", false);
    assertStringIncludes(inj, "error");
  },
});

import { validateUpload } from "../kiwi-ingest/validate.ts";
Deno.test("upload validation", () => {
  const base = { month_start: "2026-11-01", month_end: "2026-11-30" };
  assert(validateUpload({ ...base, production: [{ report_date: "2026-11-03", shift: 1, line: 2, cases_produced: 1414, filler_start: "06:31:00" }] }).ok);
  assert(!validateUpload({ month_start: "2026-11-01", month_end: "2026-12-31" }).ok);
  assert(!validateUpload({ month_start: "2026-11-02", month_end: "2026-11-30" }).ok);
  assert(!validateUpload({ ...base, notes: [{ report_date: "2026-12-01", shift: 1 }] }).ok);
  assert(!validateUpload({ ...base, people: [{ report_date: "2026-11-03", shift: 1, kind: "boss", name: "x" }] }).ok);
  assert(!validateUpload({ ...base, downtime: [{ report_date: "2026-11-03", shift: 3, line: 1 }] }).ok);
  assert(!validateUpload({ ...base, production: new Array(2001).fill({ report_date: "2026-11-03", shift: 1 }) }).ok);
  const v = validateUpload({ ...base, people: [{ report_date: "2026-11-03", shift: 1, kind: "absence", name: "x", id: 9, evil: "y" }] });
  assert(v.ok && !("id" in (v.upload.people[0] as object)) && !("evil" in (v.upload.people[0] as object)));
});
