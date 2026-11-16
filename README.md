# lingo

A small translation service for your own apps. Apps write their texts in one language; when a page,
a notification or a report needs another, they ask lingo. lingo answers from its **translation
memory** when it has seen the text before, and otherwise asks a model through **any
OpenAI-compatible endpoint** (OpenAI, OpenRouter, a local Ollama or vLLM, or a gateway of your own),
**checks** the answer and keeps it.

- **One memory for everything an app shows**: UI labels, sentences produced at run time (health
  findings, AI summaries, notifications), names from configuration.
- **Bounded wait**: a caller says how long it can wait; what is not ready by then comes back in
  the source language, marked `pending`, and is there next time. The included client falls back to
  the original text on network failure.
- **Glossary**: terms that stay as they are (product names, commands) and terms with a fixed
  translation, globally and per app. When an entry changes, translations it affected are made again.
- **Checks**: placeholders (`{n}`, `%s`, `{{name}}`), code in backticks, URLs, numbers, HTML tags and
  link targets must survive, and the glossary must be followed; a wrong answer is retried once with
  what was wrong, then the source text is used.
- **People win**: a translation set by a person is used from then on and never replaced by the model.
- **Catalogs at build time**: turn your `en.json` into `ja.json`, `fr.json`… before a release, from
  the same memory, so static UI text costs nothing at run time and can be reviewed in your repo.
- **Small application**: Node 22.13+, Fastify, the built-in `node:sqlite`; optional llama.cpp runs inside the same container and its GGUF lives in a persistent volume.

## Quick start

```bash
npm install
cp .env.example .env              # set LINGO_LLM_URL, LINGO_LLM_KEY, LINGO_MODEL
LINGO_ENV=.env npm run cli -- token create --app myapp     # prints a token once
LINGO_ENV=.env npm start
```

```bash
curl -s localhost:8790/v1/translate -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to": "ja", "texts": ["{n} parts", {"text": "Home", "kind": "name", "context": "a place where machines stand"}]}'
# The translations depend on the configured model; check `source` and `pending` before using them.
```

## Docker Compose

```bash
cp .env.example .env
# Configure LINGO_LLM_URL, LINGO_MODEL, and LINGO_LLM_KEY if the provider requires it.
# Set LINGO_ADMIN_PORT=8791 and LINGO_ADMIN_TOKEN only if you need the review pages.
# The Docker network named caddy must already exist on the host with Caddy.
docker compose up -d --build
docker compose run --rm lingo node --import tsx src/cli.ts token create --app myapp
```

Save the generated app token in your secret manager. Compose publishes **no host ports**. Open the
protected admin «Каналы» page and click «Скачать модель» to download Hy-MT2-7B Q4 on demand. The
application checks free space, the pinned download size and SHA-256, writes to a `.part` file, atomically
renames the verified GGUF and starts llama.cpp bound only to container loopback. The browser shows
download progress and startup state. A partial file is removed on failure or restart; retry with the same
button (downloads restart from the beginning); if the verified model failed to start, use
«Повторить запуск» instead. The GGUF is **not in the image**: it persists in the
`lingo-models` volume. Keep both `lingo-models` and `lingo-data` when recreating the container.
The default channel stays `remote` until an administrator changes it. The local channel returns 503
until the model is ready; it never silently uses the remote endpoint. On a CPU-only host, model output
is slower than the remote channel. Caddy
must share the external Docker network `caddy` with lingo: proxy the API to `lingo:8790`, and
the optional admin page to `lingo:8791` when `LINGO_ADMIN_PORT=8791` and `LINGO_ADMIN_TOKEN`
are set. Configure Caddy's HTTPS and access policy separately; this repository does not define
domains or Caddy routes. A Caddy instance on a different Docker host cannot use this shared
network directly and needs an explicitly configured private route instead.
SQLite (including translation memory, reviews, glossary, and app token hashes) persists in the
`lingo-data` volume. Back it up together with any glossary file you mount. `docker compose down -v`
**deletes both** SQLite and the downloaded model.

The application container runs as the unprivileged `node` user; `LINGO_LLM_URL` must be
reachable **from inside the container** (a host's `127.0.0.1` is not the container's host). The
service is a single SQLite writer; this Compose file does not support horizontal replicas.

## API

All under `/v1`, with `Authorization: Bearer <token>`; a token belongs to one app, and each app has
its own memory and glossary. Languages are BCP 47 tags (`zh-Hans`, `zh-Hant`, `ja`, `fr` …); a
tag close to a supported one is mapped to it (`zh-TW` → `zh-Hant`, `fr-CA` → `fr`).

| | |
|---|---|
| `POST /v1/translate` | `{to, from?, texts: [string \| {text, context?, kind?: "name"}], wait?, channel?}` → `{channel, translations: [{text, source, pending?}]}` in order. `source`: `memory`, `human`, `model`, `original` (could not be had), `same`. `wait` (ms, default 10000) is how long to wait for the model. At most 100 texts of 6000 characters. |
| `POST /v1/catalog` | `{to: [lang], from?, entries: {key: text}, context?, channel?}` → `{channel, catalogs: {lang: {key: text}}, missing: {lang: [key]}}`. Up to 10 requested languages and 100 entries per call, text at most 6000 characters. Waits for everything; uses the catalog model. The CLI splits larger catalogs into batches; `--channel remote\|local` selects its channel. |
| `GET /v1/channels` | available channels, model status and the current default (requires an app token). `channel` is `remote` or `local`; an explicit request choice overrides the default. Invalid or unconfigured choices return 400, a local model that is not ready returns 503; never silently fall back to the other provider. |
| `GET /v1/languages` | the supported languages (no token needed). |
| `GET`, `PUT /v1/glossary` | this app's entries (with the global ones it does not shadow); `PUT {entries: [{term, rule: "keep" \| "fixed", to?: {lang: text}, note?}]}` replaces this app's. |
| `PUT /v1/memory` | `{to, from?, text, translation}`: a person's translation. |
| `GET /v1/memory?q=&lang=&limit=` | search this app's memory; positive limit 1–500 (default 50). |

In a catalog each entry's key is sent to the model with the context (`key: panel_open_url`), which tells it what a short label is for. `context` helps the model and is not part of the memory's key: the same text gets the same
translation wherever it appears. Use a different text when you need a different translation.

For a monitor, behind `OPS_TOKEN`, the [OPStead](https://github.com/opstead/opstead) contract at level 4:
`GET /ops/health` (the database, the model answers, failures today, queue), `GET /ops/metrics`
(Prometheus), `GET /ops/manifest` (what lingo is made of and runs on, its tools and actions), read-only
`GET /ops/tools/<name>` (`model_status`, `usage`, `lookup`), and `POST /ops/actions/<name>`:

| Action | Does | Risk, limit |
|---|---|---|
| `probe_model` | one test text to the model, kept nowhere, so the model check is current; refused while the last call succeeded | low, 6/1h |
| `retranslate` | forgets one unreviewed model translation (`app`, `text`, `lang`) so it is made again; never a person's or an import | medium, 20/1d |
| `reload_glossary` | reads `LINGO_GLOSSARY` into the database again, as a restart does; refused when it already matches | medium, 3/1d |

Each accepts `"dry_run": true` and an `Idempotency-Key`, re-checks itself (409 when it should not run),
holds its limit, and is logged in the `ops_actions` table. `LINGO_SERVICE` names the host service for the
manifest, and `LINGO_PROVIDERS` the companies it runs on (`hosting:self`, or e.g.
`hosting:Hetzner,edge:Cloudflare`; level 2 needs a hosting one). `GET /healthz` is open.

## Admin pages

With `LINGO_ADMIN_PORT` and `LINGO_ADMIN_TOKEN`, a second port serves a Russian-language React
admin app using native Gravity UI UIKit components and its default theme (system light/dark):

- **Сводка**: per app and language, how many translations, how many a person corrected, how many
  wait for review, and today's hits, new translations and failures.
- **Проверка**: what the model made and nobody has looked at, most used first. «Подтвердить перевод»,
  correct it with «Сохранить исправление», or «Перевести заново».
- **Память**: search either language; `memory?app=…&lang=…&q=<source>&exact=1` opens one text, for a
  "this translation is wrong" link from your app.
- **Глоссарий**: global and per app.
- **Каналы**: download the GGUF with progress, see model readiness, choose the default model and translate an individual text through the selected channel. Protected `POST /api/model/download` starts a download, `POST /api/model/start` retries a failed model launch, and `GET /api/channels` reports status.

Navigation and static assets resolve relative to the mounted URL, so the app works behind a proxy
under any path. Opening the panel without a session shows a token sign-in form. Submit
`LINGO_ADMIN_TOKEN` there; the server sets a Secure, HttpOnly, SameSite=Strict cookie. API clients
can instead use `Authorization: Bearer <token>`.
Keep the admin port behind a trusted reverse proxy and an IP allowlist or equivalent network boundary.
Do not put the token in the URL.

For a source checkout, run `npm run build:admin` before starting the service with an admin port;
Docker builds the UI bundle in a separate build stage and serves it on the same admin port.

## Client

`src/client.ts` has no dependencies; copy it into an app or import it.

```ts
import { createClient, pick } from "./lingo-client.ts";
const lingo = createClient({ url: process.env.LINGO_URL!, token: process.env.LINGO_TOKEN!, timeoutMs: 3000 });
const lang = pick(req.headers["accept-language"], await lingo.languages());
const [title, detail] = await lingo.translate(["Every part, by where it runs", problem.detail], lang);
```

## CLI

```text
lingo token create --app <app> [--note <text>]   a token for an app; printed once
lingo token list
lingo glossary load <file.json> [--app <app>]    replace the global (or an app's) glossary
lingo import <file.jsonl> --app <app> --to <lang> [--from en]
                                                 translations made elsewhere: {"source"|"hash", "text"} per line
lingo catalog <en.json> --to ja,fr --out <dir>   with LINGO_URL and LINGO_TOKEN: <dir>/<lang>.json
```

`hash` is the SHA-256 of the trimmed source text, so a cache keyed the same way imports without
its source texts.

## Configuration

See [.env.example](.env.example). The model is anything that speaks `POST {LINGO_LLM_URL}/chat/completions`.
Two models can be set: `LINGO_MODEL` for texts asked for at run time (fast, cheap) and
`LINGO_CATALOG_MODEL` for catalogs (careful). With a gateway that routes by name, these can be
purpose names rather than model names.
Outside Compose, `LINGO_LOCAL_MODEL_DIR` enables the `local` channel only if you also install the
llama.cpp binary and shared libraries under `/app`; `LINGO_LOCAL_MODEL` and
`LINGO_LOCAL_LLM_TIMEOUT_MS` configure its API alias and timeout. Compose packages the binary, but
downloads the GGUF only after an admin request.
The default is stored in SQLite through the admin panel; existing imported or human-reviewed texts
are shared across channels, while unreviewed model translations are regenerated when the channel
changes. The application never auto-routes to a different model on an error.

What is sent to the model: the texts to translate, their context and the glossary entries they
mention. Do not send secrets for translation.

## Design

[docs/DESIGN.md](docs/DESIGN.md): why one source language, the three kinds of text, how the memory,
the glossary and the checks work, and what comes next (an admin page).

## License

MIT
