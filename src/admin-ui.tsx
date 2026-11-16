import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert, Box, Button, Card, Container, Flex, Link, Loader, PasswordInput, Provider,
  Select, Tab, TabList, TabProvider, Text, TextArea, TextInput,
} from "@gravity-ui/uikit";
import "@gravity-ui/uikit/styles/fonts.css";
import "@gravity-ui/uikit/styles/styles.css";

const base = new URL("./", window.location.href);
const section = ["review", "memory", "glossary"].includes(window.location.pathname.split("/").at(-1) ?? "")
  ? window.location.pathname.split("/").at(-1)! : "overview";
const url = (path: string) => new URL(path, base).toString();
const query = new URLSearchParams(window.location.search);

type Row = { app: string; hash: string; from_lang: string; lang: string; source: string; text: string; origin: string; reviewed: number; used_at: string; uses: number };
type OverviewRow = { app: string; lang: string; n: number; human: number; waiting: number; usage: { hits: number; made: number; failed: number } | null };
type GlossaryEntry = { term: string; rule: string; to: Record<string, string>; note: string };
type Options = { apps: string[]; langs: string[] };
type Data = { rows?: Row[] | OverviewRow[]; total?: number; entries?: GlossaryEntry[] };

async function read<T>(path: string): Promise<T> {
  const response = await fetch(url(path), { headers: { Accept: "application/json" } });
  if (!response.ok) throw response;
  return response.json() as Promise<T>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) { setError("Введите токен администратора"); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url("login"), { method: "POST", body: new URLSearchParams({ token }) });
      if (!response.ok) { setError(response.status === 401 ? "Неверный токен. Попробуйте ещё раз" : `Не удалось войти (HTTP ${response.status})`); return; }
      setToken("");
      onLogin();
    } catch { setError("Не удалось подключиться. Попробуйте ещё раз"); }
    finally { setBusy(false); }
  }
  return <Container size="s" gutters="spacing-5" paddingBlock="spacing-10">
    <Flex direction="column" gap="spacing-5">
      <Text variant="header-1" as="h1">lingo</Text>
      <Text color="secondary">Введите токен администратора для входа в панель</Text>
      {error && <Alert theme="danger" message={error} />}
      <form onSubmit={submit} noValidate>
        <Flex direction="column" gap="spacing-3">
          <label htmlFor="token">Токен администратора</label>
          <PasswordInput id="token" name="token" value={token} onUpdate={setToken} autoComplete="current-password" size="l" hideCopyButton controlProps={{ "aria-required": true }} />
          <Button type="submit" view="action" size="l" loading={busy}>Войти</Button>
        </Flex>
      </form>
    </Flex>
  </Container>;
}

function Overview({ rows }: { rows: OverviewRow[] }) {
  return <Flex direction="column" gap="spacing-4">
    <Text variant="header-1" as="h1">Сводка переводов</Text>
    {rows.length === 0 ? <Alert message="Переводов пока нет" /> : rows.map((r) => <Card key={`${r.app}:${r.lang}`}>
      <Box padding="spacing-4"><Flex direction="column" gap="spacing-3">
        <Text variant="subheader-2" wordBreak="break-word">{r.app} · {r.lang}</Text>
        <Flex wrap="wrap" gap="spacing-4">
          <Text><Link href={url(`memory?${new URLSearchParams({ app: r.app, lang: r.lang })}`)}>Переводов: {r.n}</Link></Text>
          <Text>Исправлено вручную: {r.human}</Text>
          <Text>{r.waiting ? <Link href={url(`review?${new URLSearchParams({ app: r.app, lang: r.lang })}`)}>На проверке: {r.waiting}</Link> : "На проверке: 0"}</Text>
        </Flex>
        <Text color="secondary">Сегодня: {r.usage ? `из памяти ${r.usage.hits} · создано ${r.usage.made} · ошибок ${r.usage.failed}` : "нет обращений"}</Text>
      </Flex></Box>
    </Card>)}
  </Flex>;
}

function Translation({ row, back, onAction }: { row: Row; back: string; onAction: (path: string, data: URLSearchParams) => Promise<void> }) {
  const [text, setText] = useState(row.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(path: string) {
    if (path === "save" && !text.trim()) { setError("Введите перевод"); return; }
    setBusy(true);
    setError("");
    try {
      await onAction(path, new URLSearchParams({ app: row.app, hash: row.hash, from: row.from_lang, lang: row.lang, source: row.source, back, text }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие"); }
    finally { setBusy(false); }
  }
  return <Card><Box padding="spacing-4"><Flex direction="column" gap="spacing-3">
    <Text variant="subheader-2" wordBreak="break-word">{row.source || "(импортировано без исходного текста)"}</Text>
    <Text color="secondary" wordBreak="break-word">{row.app} · {row.from_lang} → {row.lang} · {row.origin === "model" ? "модель" : row.origin === "human" ? "исправлено вручную" : row.origin === "import" ? "импортировано" : row.origin}{row.reviewed ? "" : ", не проверено"} · использований: {row.uses} · {row.used_at}</Text>
    <TextArea value={text} onUpdate={setText} minRows={2} maxRows={6} controlProps={{ "aria-label": `Перевод текста «${row.source || row.hash}» на ${row.lang}` }} />
    {error && <Alert theme="danger" message={error} />}
    <Flex wrap="wrap" gap="spacing-2">
      <Button view="action" disabled={busy} onClick={() => void act("save")}>Сохранить исправление</Button>
      {!row.reviewed && <Button disabled={busy} onClick={() => void act("approve")}>Подтвердить перевод</Button>}
      {row.source && row.origin === "model" && !row.reviewed && <Button view="outlined-danger" disabled={busy} onClick={() => void act("retranslate")}>Перевести заново</Button>}
    </Flex>
  </Flex></Box></Card>;
}

function Translations({ rows, total, options, onAction }: { rows: Row[]; total?: number; options: Options; onAction: (path: string, data: URLSearchParams) => Promise<void> }) {
  const [app, setApp] = useState(query.get("app") ?? "");
  const [lang, setLang] = useState(query.get("lang") ?? "");
  const [search, setSearch] = useState(query.get("q") ?? "");
  const review = section === "review";
  function show(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (app) params.set("app", app);
    if (lang) params.set("lang", lang);
    if (!review && search) params.set("q", search);
    window.location.assign(url(`${section}${params.size ? `?${params}` : ""}`));
  }
  const back = `${section}${window.location.search}`;
  return <Flex direction="column" gap="spacing-5">
    <Text variant="header-1" as="h1">{review ? `На проверке: ${total ?? 0}` : "Память переводов"}</Text>
    {review && <Text color="secondary">Сначала часто используемые. Подтверждение уберёт перевод из списка; исправление сохранит ваш вариант.</Text>}
    <form onSubmit={show}><Flex wrap="wrap" gap="spacing-2" alignItems="end">
      <Select label="Приложение" options={[{ value: "", content: "Все приложения" }, ...options.apps.map((a) => ({ value: a, content: a }))]} value={[app]} onUpdate={(v) => setApp(v[0] ?? "")} />
      <Select label="Язык" options={[{ value: "", content: "Все языки" }, ...options.langs.map((l) => ({ value: l, content: l }))]} value={[lang]} onUpdate={(v) => setLang(v[0] ?? "")} />
      {!review && <TextInput value={search} onUpdate={setSearch} placeholder="Текст на любом языке" controlProps={{ "aria-label": "Поиск переводов" }} />}
      <Button type="submit">Показать</Button>
    </Flex></form>
    {review && rows.length > 0 && <Button onClick={() => void onAction("approve", new URLSearchParams([...rows.map((r) => ["key", `${r.app}\u0000${r.hash}\u0000${r.from_lang}\u0000${r.lang}`]), ["back", back]]))}>Подтвердить показанные: {rows.length}</Button>}
    {rows.length === 0 ? <Alert message={review ? "Нет переводов на проверке" : query.has("exact") ? "Этот текст ещё не переводили. Перевод появится при следующем запросе" : "Ничего не найдено"} /> : rows.map((r) => <Translation key={`${r.app}:${r.hash}:${r.from_lang}:${r.lang}`} row={r} back={back} onAction={onAction} />)}
  </Flex>;
}

function Glossary({ entries, options, onAction }: { entries: GlossaryEntry[]; options: Options; onAction: (path: string, data: URLSearchParams) => Promise<void> }) {
  const scope = query.get("app") ?? "";
  const [selected, setSelected] = useState(scope);
  const [term, setTerm] = useState("");
  const [rule, setRule] = useState("keep");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!term.trim() || (rule === "fixed" && !to.trim())) { setError("Укажите термин и переводы для правила «Заданный перевод»"); return; }
    try { setError(""); await onAction("glossary/add", new URLSearchParams({ scope: scope || "*", term, rule, to, note })); setTerm(""); setTo(""); setNote(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось добавить термин"); }
  }
  return <Flex direction="column" gap="spacing-5">
    <Text variant="header-1" as="h1">Глоссарий: {scope || "общий"}</Text>
    <form onSubmit={(event) => { event.preventDefault(); window.location.assign(url(`glossary${selected ? `?${new URLSearchParams({ app: selected })}` : ""}`)); }}>
      <Flex gap="spacing-2" alignItems="end" wrap="wrap">
        <Select label="Приложение" options={[{ value: "", content: "Общий" }, ...options.apps.map((a) => ({ value: a, content: a }))]} value={[selected]} onUpdate={(v) => setSelected(v[0] ?? "")} />
        <Button type="submit">Показать</Button>
      </Flex>
    </form>
    <Text color="secondary">«Не переводить» сохраняет имена и команды, «Заданный перевод» использует указанный вариант. Правила приложения имеют приоритет над общими.</Text>
    {entries.length === 0 ? <Alert message="В глоссарии пока нет терминов" /> : entries.map((e) => <Card key={e.term}><Box padding="spacing-4">
      <Flex direction="column" gap="spacing-2">
        <Text variant="subheader-2" wordBreak="break-word">{e.term} · {e.rule === "keep" ? "не переводить" : e.rule === "fixed" ? "заданный перевод" : e.rule}</Text>
        {Object.entries(e.to).map(([lang, text]) => <Text key={lang} wordBreak="break-word">{lang}: {text}</Text>)}
        {e.note && <Text color="secondary" wordBreak="break-word">{e.note}</Text>}
        <Box><Button view="outlined-danger" onClick={() => void onAction("glossary/remove", new URLSearchParams({ scope: scope || "*", term: e.term }))}>Удалить термин</Button></Box>
      </Flex>
    </Box></Card>)}
    <Text variant="subheader-2">Добавить термин</Text>
    {error && <Alert theme="danger" message={error} />}
    <form onSubmit={add} noValidate><Flex direction="column" gap="spacing-3">
      <TextInput value={term} onUpdate={setTerm} placeholder="Термин" controlProps={{ "aria-label": "Термин" }} />
      <Select label="Правило" options={[{ value: "keep", content: "Не переводить" }, { value: "fixed", content: "Заданный перевод" }]} value={[rule]} onUpdate={(v) => setRule(v[0] ?? "keep")} />
      {rule === "fixed" && <TextInput value={to} onUpdate={setTo} placeholder="ja=…; fr=…" controlProps={{ "aria-label": "Переводы по языкам" }} />}
      <TextInput value={note} onUpdate={setNote} placeholder="Примечание" controlProps={{ "aria-label": "Примечание" }} />
      <Box><Button type="submit" view="action">Добавить</Button></Box>
    </Flex></form>
  </Flex>;
}

function App() {
  const [state, setState] = useState<"loading" | "login" | "ready" | "error">("loading");
  const [data, setData] = useState<Data>({});
  const [options, setOptions] = useState<Options>({ apps: [], langs: [] });
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([read<Options>("api/options"), read<Data>(`api/${section}${window.location.search}`)])
      .then(([o, d]) => { if (active) { setOptions(o); setData(d); setState("ready"); } })
      .catch((cause) => { if (active) { setError(cause instanceof Response ? `Не удалось загрузить данные (HTTP ${cause.status})` : "Не удалось загрузить данные"); setState(cause instanceof Response && cause.status === 401 ? "login" : "error"); } });
    return () => { active = false; };
  }, [revision]);
  async function action(path: string, form: URLSearchParams) {
    const response = await fetch(url(path), { method: "POST", body: form });
    if (response.status === 401) { setState("login"); throw new Error("Сеанс завершён. Войдите снова"); }
    if (!response.ok) throw new Error(`Не удалось выполнить действие (HTTP ${response.status})`);
    setRevision((current) => current + 1);
  }
  return <Provider theme="system" lang="ru"><Container size="l" gutters={{ xs: "spacing-4", l: "spacing-5" }} paddingBlock="spacing-5">
    {state === "loading" ? <Loader size="m" /> : state === "login" ? <Login onLogin={() => { setState("loading"); setRevision((current) => current + 1); }} /> : state === "error" ? <Alert theme="danger" message={error} /> :
      <Flex direction="column" gap="spacing-5">
        <Text variant="header-2">lingo</Text>
        <TabProvider value={section} onUpdate={(value) => window.location.assign(url(value === "overview" ? "" : value))}>
          <TabList contentOverflow="collapse">
            <Tab value="overview" href={url("")}>Сводка</Tab>
            <Tab value="review" href={url("review")}>Проверка</Tab>
            <Tab value="memory" href={url("memory")}>Память</Tab>
            <Tab value="glossary" href={url("glossary")}>Глоссарий</Tab>
          </TabList>
        </TabProvider>
        {section === "overview" ? <Overview rows={data.rows as OverviewRow[] ?? []} /> : section === "glossary" ? <Glossary entries={data.entries ?? []} options={options} onAction={action} /> : <Translations rows={data.rows as Row[] ?? []} total={data.total} options={options} onAction={action} />}
      </Flex>}
  </Container></Provider>;
}

createRoot(document.getElementById("root")!).render(<App />);
