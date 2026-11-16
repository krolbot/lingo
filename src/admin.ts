import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Channel, Engine } from "./engine.ts";
import type { LocalModel } from "./local-model.ts";
import { setEntries, type Entry } from "./glossary.ts";

/** The admin API is separate from the translation API; the browser bundle is public, data is not. */
export function buildAdmin(cfg: Config, db: Db, engine: Engine, model?: LocalModel): FastifyInstance {
  const app = Fastify({ logger: false });
  const index = readFileSync(fileURLToPath(new URL("../dist/admin/index.html", import.meta.url)), "utf8");
  const assets = new URL("../dist/admin/assets/", import.meta.url);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const p = new URLSearchParams(body as string);
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of p) out[k] = k in out ? [...([] as string[]).concat(out[k]!), v] : v;
    done(null, out);
  });

  const want = cfg.adminToken ? createHash("sha256").update(cfg.adminToken).digest() : null;
  const ok = (given: string) => !!want && timingSafeEqual(createHash("sha256").update(given).digest(), want);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    if (req.method === "POST" && req.url === "/login") return;
    if (req.method === "GET" && (/^\/(?:review|memory|glossary|channels)?(?:\?.*)?$/.test(req.url) || /^\/assets\//.test(req.url))) return;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const cookie = /(?:^|;\s*)lingo_admin=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    let decoded = "";
    try { decoded = decodeURIComponent(cookie); } catch { /* malformed cookie is not a credential */ }
    if (!ok(bearer) && !ok(decoded)) return reply.code(401).send({ error: "a valid administrator token is needed" });
  });

  app.post<{ Body: Record<string, string | string[] | undefined> }>("/login", async (req, reply) => {
    const token = req.body?.token;
    if (typeof token !== "string" || !ok(token)) return reply.code(401).send({ error: "Invalid token. Try again." });
    reply.header("set-cookie", `lingo_admin=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return reply.redirect("./", 303);
  });

  app.get<{ Params: { file: string } }>("/assets/:file", async (req, reply) => {
    const file = req.params.file;
    if (!/^[\w.-]+\.(?:js|css|woff2?|svg|png)$/.test(file)) return reply.code(404).send();
    try {
      const data = await readFile(fileURLToPath(new URL(file, assets)));
      const ext = file.slice(file.lastIndexOf("."));
      reply.type(({ ".js": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" } as Record<string, string>)[ext]!);
      return reply.send(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send();
      throw err;
    }
  });
  for (const path of ["/", "/review", "/memory", "/glossary", "/channels"]) app.get(path, async (_req, reply) => reply.type("text/html").send(index));
  const apps = () => (db.prepare("SELECT DISTINCT app FROM memory UNION SELECT DISTINCT app FROM tokens ORDER BY 1").all() as Array<{ app: string }>).map((r) => r.app);
  app.get("/api/options", async () => ({ apps: apps(), langs: cfg.langs.filter((l) => l !== cfg.sourceLang) }));
  app.get("/api/channels", async () => ({ ...engine.channels(), model: model?.status() ?? null }));
  const jsonAction = (req: FastifyRequest) => req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json";
  app.post("/api/model/download", async (req, reply) => {
    if (!jsonAction(req)) return reply.code(415).send({ error: "JSON content type is required" });
    if (!model) return reply.code(404).send({ error: "local model is not configured" });
    if (!model.startDownload()) return reply.code(409).send({ error: "model already installed or downloading" });
    return reply.code(202).send(model.status());
  });
  app.post("/api/model/start", async (req, reply) => {
    if (!jsonAction(req)) return reply.code(415).send({ error: "JSON content type is required" });
    if (!model) return reply.code(404).send({ error: "local model is not configured" });
    if (!model.start()) return reply.code(409).send({ error: "model is already running or has not been downloaded" });
    return reply.code(202).send(model.status());
  });
  app.post<{ Body: { channel?: Channel } }>("/api/channels", async (req, reply) => {
    const selected = req.body?.channel;
    if (selected !== "remote" && selected !== "local" || !engine.channels().available.includes(selected)) return reply.code(400).send({ error: "channel is unavailable" });
    if (selected === "local" && !model?.ready) return reply.code(503).send({ error: "local model is not ready" });
    engine.setDefaultChannel(selected);
    return { ...engine.channels(), model: model?.status() ?? null };
  });
  app.post<{ Body: { app?: string; to?: string; text?: string; channel?: Channel } }>("/api/translate", async (req, reply) => {
    const { app: scope, to, text, channel } = req.body ?? {};
    if (typeof scope !== "string" || !apps().includes(scope) || typeof to !== "string" || !cfg.langs.includes(to) ||
      typeof text !== "string" || !text.trim() || text.length > 6000 ||
      (channel !== "remote" && channel !== "local") || !engine.channels().available.includes(channel)) {
      return reply.code(400).send({ error: "app, language, text and an available channel are required" });
    }
    if (channel === "local" && !model?.ready) return reply.code(503).send({ error: "local model is not ready" });
    const [translation] = await engine.translate(scope, [{ text }], to, { channel, wait: 120_000 });
    return { channel, translation };
  });
  const where = (v: { app?: string; lang?: string; q?: string }, extra: string[] = []) => {
    const parts = [...extra], args: string[] = [];
    if (v.app) { parts.push("app = ?"); args.push(v.app); }
    if (v.lang) { parts.push("lang = ?"); args.push(v.lang); }
    if (v.q) { parts.push("(source LIKE ? OR text LIKE ?)"); args.push(`%${v.q}%`, `%${v.q}%`); }
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
  };

  app.get("/api/overview", async () => {
    const rows = db.prepare(`SELECT app, lang, count(*) AS n, sum(origin = 'human') AS human, sum(reviewed = 0) AS waiting FROM memory GROUP BY app, lang ORDER BY app, lang`).all() as Array<{ app: string; lang: string; n: number; human: number; waiting: number }>;
    const today = db.prepare(`SELECT app, lang, hits, made, failed FROM usage WHERE day = date('now') ORDER BY app, lang`).all() as Array<{ app: string; lang: string; hits: number; made: number; failed: number }>;
    const use = new Map(today.map((u) => [`${u.app}\u0000${u.lang}`, u]));
    return { rows: rows.map((r) => ({ ...r, usage: use.get(`${r.app}\u0000${r.lang}`) ?? null })) };
  });
  app.get<{ Querystring: { app?: string; lang?: string } }>("/api/review", async (req) => {
    const w = where(req.query, ["reviewed = 0"]);
    return {
      rows: db.prepare(`SELECT * FROM memory ${w.sql} ORDER BY uses DESC, used_at DESC LIMIT 100`).all(...w.args),
      total: (db.prepare(`SELECT count(*) AS n FROM memory ${w.sql}`).get(...w.args) as { n: number }).n,
    };
  });
  app.get<{ Querystring: { app?: string; lang?: string; q?: string; exact?: string } }>("/api/memory", async (req) => {
    const v = req.query;
    const w = v.exact && v.q ? { sql: `WHERE source = ?${v.app ? " AND app = ?" : ""}${v.lang ? " AND lang = ?" : ""}`, args: [v.q.trim(), ...(v.app ? [v.app] : []), ...(v.lang ? [v.lang] : [])] } : where(v);
    return { rows: db.prepare(`SELECT * FROM memory ${w.sql} ORDER BY used_at DESC LIMIT 100`).all(...w.args) };
  });
  app.get<{ Querystring: { app?: string } }>("/api/glossary", async (req) => {
    const scope = req.query.app || "*";
    const entries = db.prepare("SELECT term, rule, tr, note FROM glossary WHERE scope = ? ORDER BY term COLLATE NOCASE").all(scope) as Array<{ term: string; rule: string; tr: string; note: string }>;
    return { scope, entries: entries.map((e) => ({ term: e.term, rule: e.rule, to: JSON.parse(e.tr) as Record<string, string>, note: e.note })) };
  });

  type Form = Record<string, string | string[] | undefined>;
  const one = (f: Form, k: string) => (Array.isArray(f[k]) ? (f[k] as string[])[0] : (f[k] as string | undefined)) ?? "";
  const backTo = (f: Form) => {
    const b = one(f, "back");
    return /^(review|memory|glossary)(\?|$)/.test(b) ? b : "./";
  };
  app.post<{ Body: Form }>("/save", async (req, reply) => {
    const f = req.body ?? {};
    const text = one(f, "text").trim();
    if (text) db.prepare("UPDATE memory SET text = ?, origin = 'human', reviewed = 1, created_at = datetime('now') WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?").run(text, one(f, "app"), one(f, "hash"), one(f, "from"), one(f, "lang"));
    return reply.redirect(backTo(f), 303);
  });
  app.post<{ Body: Form }>("/approve", async (req, reply) => {
    const f = req.body ?? {};
    const keys = f.key ? ([] as string[]).concat(f.key as string | string[]) : [`${one(f, "app")}\u0000${one(f, "hash")}\u0000${one(f, "from")}\u0000${one(f, "lang")}`];
    const st = db.prepare("UPDATE memory SET reviewed = 1 WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ?");
    for (const k of keys) {
      const [a, h, fr, l] = k.split("\u0000");
      if (a && h && fr && l) st.run(a, h, fr, l);
    }
    return reply.redirect(backTo(f), 303);
  });
  app.post<{ Body: Form }>("/retranslate", async (req, reply) => {
    const f = req.body ?? {};
    db.prepare("DELETE FROM memory WHERE app = ? AND hash = ? AND from_lang = ? AND lang = ? AND source <> '' AND origin = 'model' AND reviewed = 0").run(one(f, "app"), one(f, "hash"), one(f, "from"), one(f, "lang"));
    return reply.redirect(backTo(f), 303);
  });
  app.post<{ Body: Form }>("/glossary/add", async (req, reply) => {
    const f = req.body ?? {};
    const scope = one(f, "scope") || "*", term = one(f, "term").trim(), rule = one(f, "rule") === "fixed" ? "fixed" : "keep";
    if (term) {
      const to = Object.fromEntries(one(f, "to").split(";").map((p) => p.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]) as Array<[string, string]>);
      const rest: Entry[] = (db.prepare("SELECT term, rule, tr, note FROM glossary WHERE scope = ?").all(scope) as Array<{ term: string; rule: Entry["rule"]; tr: string; note: string }>).map((e) => ({ term: e.term, rule: e.rule, to: JSON.parse(e.tr) as Record<string, string>, note: e.note || undefined }));
      setEntries(db, scope, [...rest.filter((e) => e.term.toLowerCase() !== term.toLowerCase()), { term, rule, to, note: one(f, "note") || undefined }]);
    }
    return reply.redirect(`../glossary${scope === "*" ? "" : `?${new URLSearchParams({ app: scope })}`}`, 303);
  });
  app.post<{ Body: Form }>("/glossary/remove", async (req, reply) => {
    const f = req.body ?? {};
    db.prepare("DELETE FROM glossary WHERE scope = ? AND term = ?").run(one(f, "scope") || "*", one(f, "term"));
    const scope = one(f, "scope");
    return reply.redirect(`../glossary${scope && scope !== "*" ? `?${new URLSearchParams({ app: scope })}` : ""}`, 303);
  });
  return app;
}
