import { describe, expect, it } from "vitest";
import { buildAdmin } from "../src/admin.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createEngine, hashOf } from "../src/engine.ts";
import { entriesOf } from "../src/glossary.ts";
import type { Chat } from "../src/llm.ts";

const chat: Chat = async (_m, msgs) => JSON.stringify({ translations: (JSON.parse(msgs[1]!.content) as { items: Array<{ text: string }> }).items.map((i) => `ja:${i.text}`) });

async function setup() {
  const cfg = { ...loadConfig({}), langs: ["en", "ja", "fr"], adminToken: "adm" };
  const db = openDb(":memory:");
  const engine = createEngine(db, chat, cfg);
  await engine.translate("ops", [{ text: "fold" }, { text: "open" }], "ja");
  engine.setHuman("ops", "en", "ja", "Home", "自宅");
  return { db, engine, admin: buildAdmin(cfg, db) };
}
const auth = { authorization: "Bearer adm" };
const form = (o: Record<string, string>) => ({ headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(o).toString() });

describe("admin", () => {
  it("renders sign-in on protected pages and accepts the token through the form", async () => {
    const { admin } = await setup();
    const signin = await admin.inject({ url: "/" });
    expect(signin.statusCode).toBe(401);
    expect(signin.headers["content-type"]).toContain("text/html");
    expect(signin.body).toContain('<form method="post" action="login">');
    expect(signin.body).toContain('name="token" type="password"');
    expect((await admin.inject({ url: "/glossary/add" })).body).toContain('action="../login"');
    expect((await admin.inject({ url: "/", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await admin.inject({ url: "/", headers: { cookie: "lingo_admin=%" } })).statusCode).toBe(401);
    expect((await admin.inject({ url: "/?token=adm" })).headers["set-cookie"]).toBeUndefined();

    const invalid = await admin.inject({ method: "POST", url: "/login", payload: new URLSearchParams({ token: "wrong" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).toContain('role="alert"');
    expect(invalid.body).not.toContain("wrong");
    expect(invalid.headers["set-cookie"]).toBeUndefined();

    const valid = await admin.inject({ method: "POST", url: "/login", payload: new URLSearchParams({ token: "adm" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(valid.statusCode).toBe(303);
    expect(valid.headers.location).toBe("./");
    expect(valid.headers["set-cookie"]).toMatch(/lingo_admin=adm; Path=\/; Secure; HttpOnly; SameSite=Strict/);
    expect((await admin.inject({ url: "/", headers: { cookie: "lingo_admin=adm" } })).statusCode).toBe(200);
    expect((await admin.inject({ url: "/", headers: auth })).statusCode).toBe(200);
  });

  it("lists what waits for review, takes corrections, approvals and a request to translate again", async () => {
    const { db, admin, engine } = await setup();
    const overview = (await admin.inject({ url: "/", headers: auth })).body;
    expect(overview).toContain('href="review?app=ops&lang=ja">2</a>'); // fold and open; Home was set by a person
    const review = (await admin.inject({ url: "/review?app=ops&lang=ja", headers: auth })).body;
    expect(review).toContain(">fold<");
    expect(review).not.toContain(">Home<");
    expect(review).not.toMatch(/(href|action)="\//); // relative only: works under any proxy path
    const key = { app: "ops", hash: hashOf("fold"), from: "en", lang: "ja", back: "review?app=ops" };
    const saved = await admin.inject({ method: "POST", url: "/save", ...form({ ...key, text: "折りたたむ" }) });
    expect(saved.headers.location).toBe("review?app=ops");
    expect(await engine.translate("ops", [{ text: "fold" }], "ja")).toEqual([{ text: "折りたたむ", source: "human" }]);
    await admin.inject({ method: "POST", url: "/approve", ...form({ ...key, hash: hashOf("open") }) });
    expect((db.prepare("SELECT count(*) AS n FROM memory WHERE reviewed = 0").get() as { n: number }).n).toBe(0);
    await admin.inject({ method: "POST", url: "/retranslate", ...form({ ...key, hash: hashOf("open") }) });
    expect(db.prepare("SELECT 1 FROM memory WHERE hash = ?").get(hashOf("open"))).toBeDefined(); // reviewed translations survive
    await engine.translate("ops", [{ text: "new text" }], "ja");
    await admin.inject({ method: "POST", url: "/retranslate", ...form({ ...key, hash: hashOf("new text") }) });
    expect(db.prepare("SELECT 1 FROM memory WHERE hash = ?").get(hashOf("new text"))).toBeUndefined();
    await admin.inject({ method: "POST", url: "/retranslate", ...form({ ...key, hash: hashOf("Home") }) });
    expect(db.prepare("SELECT 1 FROM memory WHERE hash = ?").get(hashOf("Home"))).toBeDefined(); // human translations survive
    // A link from a monitor to one text.
    expect((await admin.inject({ url: "/memory?app=ops&lang=ja&exact=1&q=Home", headers: auth })).body).toContain("自宅");
    // Back links go only to our own pages.
    expect((await admin.inject({ method: "POST", url: "/approve", ...form({ ...key, back: "//evil.example" }) })).headers.location).toBe("./");
  });

  it("edits the glossaries", async () => {
    const { db, admin } = await setup();
    await admin.inject({ method: "POST", url: "/glossary/add", ...form({ scope: "ops", term: "heartbeat", rule: "fixed", to: "ja=ハートビート; fr=pulsation" }) });
    await admin.inject({ method: "POST", url: "/glossary/add", ...form({ scope: "ops", term: "ingest", rule: "keep" }) });
    expect(entriesOf(db, "ops").map((e) => [e.term, e.rule, e.to])).toEqual([["heartbeat", "fixed", { ja: "ハートビート", fr: "pulsation" }], ["ingest", "keep", {}]]);
    expect((await admin.inject({ url: "/glossary?app=ops", headers: auth })).body).toContain("ja: ハートビート");
    await admin.inject({ method: "POST", url: "/glossary/remove", ...form({ scope: "ops", term: "ingest" }) });
    expect(entriesOf(db, "ops").map((e) => e.term)).toEqual(["heartbeat"]);
  });
});
