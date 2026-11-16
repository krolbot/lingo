import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createEngine, hashOf } from "./engine.ts";
import { loadGlossaryFile, setEntries, type Entry } from "./glossary.ts";
import { openAiChat } from "./llm.ts";

const HELP = `lingo <command>

On the machine lingo runs on (reads LINGO_DB and the rest from the environment / LINGO_ENV):
  token create --app <app> [--note <text>]   a token for an app; printed once
  token list
  glossary load <file.json> [--app <app>]    replace the global (or an app's) glossary
  import <file.jsonl> --app <app> --to <lang> [--from en]
                                             translations made elsewhere, one {"hash"|"source", "text"} per line

From anywhere, against a running lingo (LINGO_URL, LINGO_TOKEN):
  catalog <en.json> --to <lang,lang> --out <dir> [--context <text>] [--channel remote|local]
                                             a flat {key: text} file into <dir>/<lang>.json for each language`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (name: string) => flag(name) ?? (console.error(`--${name} is needed\n\n${HELP}`), process.exit(2));

async function main() {
  const [cmd, sub] = args;
  if (cmd === "catalog") {
    const url = process.env.LINGO_URL, token = process.env.LINGO_TOKEN;
    if (!url || !token) throw new Error("LINGO_URL and LINGO_TOKEN are needed");
    const entries: unknown = JSON.parse(readFileSync(sub!, "utf8"));
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.entries(entries).some(([k, v]) => !k || typeof v !== "string")) throw new Error("catalog must be a flat {key: text} object");
    const languages = need("to").split(",").map((s) => s.trim()).filter(Boolean);
    const channel = flag("channel");
    if (channel && channel !== "remote" && channel !== "local") throw new Error("--channel must be remote or local");
    const keys = Object.keys(entries);
    const catalogs: Record<string, Record<string, string>> = {};
    const missing: Record<string, string[]> = {};
    for (let i = 0; i < languages.length; i += 10) {
      const to = languages.slice(i, i + 10);
      for (let j = 0; j < keys.length; j += 100) {
        const part = keys.slice(j, j + 100);
        const res = await fetch(`${url.replace(/\/+$/, "")}/v1/catalog`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ to, entries: Object.fromEntries(part.map((k) => [k, (entries as Record<string, string>)[k]])), context: flag("context"), ...(channel ? { channel } : {}) }),
          signal: AbortSignal.timeout(30 * 60_000),
        });
        if (!res.ok) throw new Error(`catalog HTTP ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as { catalogs: Record<string, Record<string, string>>; missing: Record<string, string[]> };
        for (const lang of Object.keys(body.catalogs)) {
          Object.assign(catalogs[lang] ??= {}, body.catalogs[lang]);
          (missing[lang] ??= []).push(...(body.missing[lang] ?? []));
        }
      }
      for (const lang of to) { catalogs[lang] ??= {}; missing[lang] ??= []; }
    }
    const out = need("out");
    mkdirSync(out, { recursive: true });
    for (const [lang, cat] of Object.entries(catalogs)) {
      writeFileSync(join(out, `${lang}.json`), `${JSON.stringify(cat, null, 2)}\n`);
      const miss = missing[lang] ?? [];
      console.log(`${lang}: ${Object.keys(cat).length} keys${miss.length ? `, ${miss.length} still in the source language: ${miss.slice(0, 10).join(", ")}${miss.length > 10 ? " …" : ""}` : ""}`);
    }
    return;
  }

  const cfg = loadConfig();
  const db = openDb(cfg.db);
  if (cmd === "token" && sub === "create") {
    const token = `lingo_${randomBytes(24).toString("base64url")}`;
    db.prepare("INSERT INTO tokens (hash, app, note) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), need("app"), flag("note") ?? "");
    console.log(token);
  } else if (cmd === "token" && sub === "list") {
    for (const r of db.prepare("SELECT app, note, created_at, substr(hash, 1, 8) AS id FROM tokens ORDER BY app").all()) console.log(Object.values(r as object).join("\t"));
  } else if (cmd === "glossary" && sub === "load") {
    const file = args[2]!;
    const app = flag("app");
    if (app) setEntries(db, app, JSON.parse(readFileSync(file, "utf8")) as Entry[]);
    else loadGlossaryFile(db, file);
    console.log(`glossary for ${app ?? "every app"} loaded`);
  } else if (cmd === "import") {
    const engine = createEngine(db, openAiChat(cfg.llm), cfg);
    const app = need("app"), to = need("to"), from = flag("from") ?? cfg.sourceLang;
    const records = readFileSync(sub!, "utf8").split("\n").map((line, i) => {
      if (!line.trim()) return null;
      const r: unknown = JSON.parse(line);
      if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`line ${i + 1}: expected an object`);
      const { hash, source, text } = r as Record<string, unknown>;
      if (typeof text !== "string" || !text.trim() ||
        (source !== undefined && (typeof source !== "string" || !source.trim())) ||
        (hash !== undefined && (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))) ||
        (!source && !hash)) throw new Error(`line ${i + 1}: expected text and source or SHA-256 hash`);
      const computed = source ? hashOf(source as string) : (hash as string).toLowerCase();
      if (hash && computed !== (hash as string).toLowerCase()) throw new Error(`line ${i + 1}: hash does not match source`);
      return { hash: computed, source: (source as string | undefined) ?? "", text };
    }).filter((r): r is { hash: string; source: string; text: string } => r !== null);
    db.exec("BEGIN");
    try {
      for (const r of records) engine.importOne(app, from, to, r.hash, r.text, r.source);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    console.log(`${records.length} translations imported for ${app} (${from} → ${to})`);
  } else {
    console.log(HELP);
    process.exit(cmd ? 2 : 0);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
