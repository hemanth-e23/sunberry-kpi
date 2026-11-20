// KIWI - checks on the SQL the AI writes, before it reaches the database.
//
// This is the second lock, not the first: the database login (kiwi_reader) can
// only SELECT from the kiwi views and every transaction is read-only. These
// checks just turn mistakes into clear messages the AI can fix.

export const MAX_ROWS = 200;

export type GuardResult = { ok: true; sql: string } | { ok: false; error: string };

export function guardSql(raw: string, opts: { allowPeople: boolean }): GuardResult {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Empty query." };
  if (raw.length > 6000) return { ok: false, error: "Query too long; keep it under 6000 characters." };

  const sql = raw.trim().replace(/;\s*$/, "");
  // Look at the query with quoted text blanked out, so a search like
  // reason ilike '%lock nut%' isn't mistaken for a LOCK statement.
  if ((sql.match(/'/g) ?? []).length % 2 !== 0) return { ok: false, error: "Unbalanced quotes." };
  const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, (m) => m.toLowerCase());
  if (code.includes(";")) return { ok: false, error: "Only one statement is allowed (no ';')." };
  if (/--|\/\*/.test(code)) return { ok: false, error: "Remove SQL comments (-- or /* */)." };
  if (!/^(select|with)\b/i.test(code)) return { ok: false, error: "Only SELECT queries are allowed." };
  if (/\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|set|reset|listen|notify|lock|refresh|pg_sleep|dblink|lo_\w+)\b/i.test(code)) {
    return { ok: false, error: "Only reading data is allowed." };
  }
  // Functions that run SQL from a string or change settings: not needed for questions.
  if (/\b(set_config|query_to_xml\w*|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|cursor_to_xml|pg_read_\w+|pg_ls_\w+|pg_stat_file|current_setting)\s*\(/i.test(code) || /\bu&/i.test(code)) {
    return { ok: false, error: "That function isn't allowed here." };
  }
  if (/\b(plant|public|auth|storage|pg_catalog|information_schema)"?\s*\./i.test(code)) {
    return { ok: false, error: "Query only the kiwi views listed in your instructions." };
  }
  if (!opts.allowPeople && /\bshift_people\b/i.test(code)) {
    return { ok: false, error: "This user may not see absence / part-day names. Tell them a manager can ask." };
  }
  // Cap rows no matter what the query asks for.
  // The limit is sent as parameter $1: that makes Postgres use the protocol that
  // accepts exactly one statement, so nothing can be chained after the query.
  return { ok: true, sql: `select * from (\n${sql}\n) as kiwi_q limit $1` };
}
