import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { buildAdmin } from "./admin.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { createEngine, type Channel, type Engine, type Item } from "./engine.ts";
import { entriesOf, loadGlossaryFile, setEntries, validEntries, type Entry } from "./glossary.ts";
import { normalize } from "./lang.ts";
import { openAiChat, type Chat } from "./llm.ts";
import { LocalModel } from "./local-model.ts";
import { registerOps } from "./ops.ts";

const MAX_ITEMS = 100, MAX_TEXT = 6000, MAX_WAIT = 120_000, MAX_CONTEXT = 500, MAX_CATALOG_LANGS = 10;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function buildApp(cfg: Config, db: Db, modelManager?: LocalModel, chat: Chat = openAiChat(cfg.llm)): { app: FastifyInstance; engine: Engine } {
  const engine = createEngine(db, chat, cfg, cfg.local ? openAiChat(cfg.local, fetch, true) : undefined);
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  let requests = 0;

  /** The app a bearer token belongs to. */
  const appOf = (req: FastifyRequest): string | null => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token) return null;
    const row = db.prepare("SELECT app FROM tokens WHERE hash = ?").get(sha(token)) as { app: string } | undefined;
    return row?.app ?? null;
  };
  const lang = (tag: unknown, reply: FastifyReply) => {
    const n = typeof tag === "string" ? normalize(tag, cfg.langs) : null;
    if (!n) reply.code(400).send({ error: `unsupported language ${String(tag)}; supported: ${cfg.langs.join(", ")}` });
    return n;
  };
  const channel = (value: unknown, reply: FastifyReply): Channel | undefined => {
    if (value === undefined) return undefined;
    if ((value !== "remote" && value !== "local") || !engine.channels().available.includes(value)) {
      reply.code(400).send({ error: "unsupported translation channel" });
      return undefined;
    }
    if (value === "local" && !modelManager?.ready) {
      reply.code(503).send({ error: "local model is not ready; download it in the admin panel" });
      return undefined;
    }
    return value;
  };

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/v1/languages", async () => ({ languages: cfg.langs, source: cfg.sourceLang }));

  // Everything below /v1 except the language list needs a token.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/") || req.url.startsWith("/v1/languages")) return;
    const who = appOf(req);
    if (!who) return reply.code(401).send({ error: "a valid bearer token is needed" });
    (req as FastifyRequest & { app: string }).app = who;
    requests++;
  });
  const who = (req: FastifyRequest) => (req as FastifyRequest & { app: string }).app;
  app.get("/v1/channels", async () => ({ ...engine.channels(), model: modelManager?.status() ?? null }));

  app.post<{ Body: { to?: string; from?: string; texts?: Array<string | Item>; wait?: number; channel?: Channel } }>("/v1/translate", async (req, reply) => {
    const b = req.body ?? {};
    const selected = channel(b.channel, reply);
    if (b.channel !== undefined && !selected) return;
    const to = lang(b.to, reply);
    if (!to) return;
    const from = b.from === undefined ? cfg.sourceLang : lang(b.from, reply);
    if (!from) return;
    if (!Array.isArray(b.texts) || b.texts.length > MAX_ITEMS) return reply.code(400).send({ error: `texts: an array of at most ${MAX_ITEMS} strings or {text, context?, kind?}` });
    if (b.texts.some((t) => typeof t !== "string" && (
      !t || typeof t !== "object" || typeof t.text !== "string" ||
      (t.context !== undefined && typeof t.context !== "string") ||
      (t.kind !== undefined && t.kind !== "text" && t.kind !== "name")
    ))) return reply.code(400).send({ error: "texts must contain strings or {text, context?, kind?}" });
    const items: Item[] = b.texts.map((t) => (typeof t === "string" ? { text: t } : t));
    if (items.some((i) => i.text.length > MAX_TEXT || (i.context?.length ?? 0) > MAX_CONTEXT)) return reply.code(400).send({ error: `text or context is too long (limits: ${MAX_TEXT}, ${MAX_CONTEXT})` });
    const wait = Math.min(Math.max(Number(b.wait ?? 10_000) || 0, 0), MAX_WAIT);
    const effective = selected ?? engine.channels().default;
    if (effective === "local" && !modelManager?.ready) return reply.code(503).send({ error: "local model is not ready; download it in the admin panel" });
    return { channel: effective, translations: await engine.translate(who(req), items, to, { from, wait, channel: effective }) };
  });

  app.post<{ Body: { to?: string[]; from?: string; entries?: Record<string, string>; context?: string; channel?: Channel } }>("/v1/catalog", async (req, reply) => {
    const b = req.body ?? {};
    const selected = channel(b.channel, reply);
    if (b.channel !== undefined && !selected) return;
    if (!Array.isArray(b.to) || b.to.length < 1 || b.to.length > MAX_CATALOG_LANGS || !b.entries || typeof b.entries !== "object" || Array.isArray(b.entries)) return reply.code(400).send({ error: `to: [up to ${MAX_CATALOG_LANGS} languages], entries: {key: text}` });
    const keys = Object.keys(b.entries);
    if (keys.length > MAX_ITEMS || keys.some((k) => !k || k.length > MAX_CONTEXT || typeof b.entries![k] !== "string" || b.entries![k].length > MAX_TEXT) ||
      (b.context !== undefined && (typeof b.context !== "string" || b.context.length > MAX_CONTEXT))) {
      return reply.code(400).send({ error: `at most ${MAX_ITEMS} entries; keys/context at most ${MAX_CONTEXT}, texts at most ${MAX_TEXT} characters` });
    }
    const tos: string[] = [];
    for (const t of b.to) {
      const n = lang(t, reply);
      if (!n) return;
      if (!tos.includes(n)) tos.push(n);
    }
    const from = b.from === undefined ? cfg.sourceLang : lang(b.from, reply);
    if (!from) return;

    // The key says what a short label is for ("panel_open_url": a link that opens something, not "unresolved").
    const items = keys.map((k) => ({ text: b.entries![k]!, context: `${b.context ? `${b.context}; ` : ""}key: ${k}` }));
    const effective = selected ?? engine.channels().default;
    if (effective === "local" && !modelManager?.ready) return reply.code(503).send({ error: "local model is not ready; download it in the admin panel" });
    const out: Record<string, Record<string, string>> = {};
    const missing: Record<string, string[]> = {};
    for (const to of tos) {
      const r = await engine.translate(who(req), items, to, { from, catalog: true, channel: effective });
      out[to] = Object.fromEntries(keys.map((k, n) => [k, r[n]!.text]));
      missing[to] = keys.filter((_, n) => r[n]!.source === "original");
    }
    return { channel: effective, catalogs: out, missing };
  });

  app.get("/v1/glossary", async (req) => ({ entries: entriesOf(db, who(req)) }));
  app.put<{ Body: { entries?: Entry[] } }>("/v1/glossary", async (req, reply) => {
    if (!validEntries(req.body?.entries)) return reply.code(400).send({ error: "entries: [{term, rule: keep|fixed, to?, note?}]" });
    setEntries(db, who(req), req.body.entries);
    return { entries: entriesOf(db, who(req)) };
  });

  // A person's translation of one text: wins over the model from now on.
  app.put<{ Body: { to?: string; from?: string; text?: string; translation?: string } }>("/v1/memory", async (req, reply) => {
    const b = req.body ?? {};
    const to = lang(b.to, reply);
    if (!to) return;
    const from = b.from === undefined ? cfg.sourceLang : lang(b.from, reply);
    if (!from) return;
    if (typeof b.text !== "string" || !b.text.trim() || typeof b.translation !== "string" || !b.translation.trim() || b.text.length > MAX_TEXT || b.translation.length > MAX_TEXT) return reply.code(400).send({ error: `text and translation are needed (at most ${MAX_TEXT} characters)` });
    engine.setHuman(who(req), from, to, b.text, b.translation);
    return { ok: true };
  });
  app.get<{ Querystring: { q?: string; lang?: string; limit?: string } }>("/v1/memory", async (req, reply) => {
    const target = req.query.lang === undefined ? undefined : lang(req.query.lang, reply);
    if (req.query.lang !== undefined && !target) return;
    const q = `%${req.query.q ?? ""}%`;
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send({ error: "limit must be a positive integer" });
    const rows = db.prepare(`SELECT source, from_lang AS "from", lang, text, origin, used_at, uses FROM memory WHERE app = ? AND (source LIKE ? OR text LIKE ?) ${target ? "AND lang = ?" : ""} ORDER BY used_at DESC LIMIT ?`)
      .all(...[who(req), q, q, ...(target ? [target] : []), Math.min(limit, 500)]);
    return { rows };
  });

  registerOps(app, cfg, db, engine, () => requests);

  return { app, engine };
}

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.db);
  if (cfg.glossaryFile) loadGlossaryFile(db, cfg.glossaryFile);
  const model = cfg.localModelDir && cfg.local ? new LocalModel(cfg.localModelDir, cfg.local.model) : undefined;
  // The remote channel must serve while the local GGUF is being verified and loaded.
  const initializing = model?.initialize();
  const { app, engine } = buildApp(cfg, db, model);
  await app.listen({ host: cfg.host, port: cfg.port });
  let admin: FastifyInstance | undefined;
  if (cfg.adminPort) {
    if (!cfg.adminToken) throw new Error("LINGO_ADMIN_PORT needs LINGO_ADMIN_TOKEN");
    admin = buildAdmin(cfg, db, engine, model);
    await admin.listen({ host: cfg.host, port: cfg.adminPort });
  }
  process.once("SIGTERM", () => { void (async () => {
    await model?.stop();
    await initializing;
    await admin?.close();
    await app.close();
    db.close();
  })().catch((err) => { console.error(err); process.exitCode = 1; }); });
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
