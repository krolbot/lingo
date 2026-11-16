import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const MODEL_NAME = "Hy-MT2-7B-Q4_K_M.gguf";
const URL = "https://huggingface.co/tencent/Hy-MT2-7B-GGUF/resolve/707464294cf5b2a5a69982855020858ed58cf1d1/Hy-MT2-7B-Q4_K_M.gguf";
const SHA256 = "9f96256500f3fc1ab4d64336b58f52a949a95ad7516b0c229476eef782f9f77b";
const SIZE = 4_624_648_896;
const MAX_BYTES = SIZE + 1;
const ENDPOINT = "http://127.0.0.1:8080/health";

export type ModelState = "not_installed" | "downloading" | "verifying" | "starting" | "ready" | "error";
export interface ModelStatus { state: ModelState; bytes: number; total: number; error?: string }

/** The application owns the model file and its localhost-only inference child. */
export class LocalModel {
  private state: ModelState = "not_installed";
  private bytes = 0;
  private error = "";
  private child?: ChildProcess;
  private downloadTask?: Promise<void>;
  private controller?: AbortController;
  private stopping = false;
  private readonly file: string;

  constructor(private readonly dir: string, private readonly alias: string) { this.file = join(dir, MODEL_NAME); }

  status(): ModelStatus {
    return { state: this.state, bytes: this.bytes, total: SIZE, ...(this.error ? { error: this.error } : {}) };
  }
  get ready() { return this.state === "ready" && this.child?.exitCode === null && !this.child?.killed; }

  async initialize() {
    this.state = "verifying";
    try {
      await mkdir(this.dir, { recursive: true });
      await unlink(`${this.file}.part`).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
      try { await access(this.file); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") this.state = "not_installed";
        else this.fail(err);
        return;
      }
      await this.verify();
      if (this.stopping) return;
      await this.startServer();
    } catch (err) {
      this.fail(err);
    }
  }

  startDownload(): boolean {
    if (this.stopping || this.state === "downloading" || this.state === "verifying" || this.state === "starting" || this.state === "ready") return false;
    this.error = "";
    this.bytes = 0;
    this.state = "downloading";
    this.controller = new AbortController();
    this.downloadTask = this.download(this.controller.signal).catch((err) => this.fail(err)).finally(() => {
      this.controller = undefined;
      this.downloadTask = undefined;
    });
    return true;
  }

  start(): boolean {
    if (this.stopping || this.state !== "error" || this.downloadTask) return false;
    this.error = "";
    this.state = "verifying";
    this.downloadTask = (async () => {
      await this.verify();
      await this.startServer();
    })().catch((err) => this.fail(err)).finally(() => { this.downloadTask = undefined; });
    return true;
  }

  private fail(err: unknown) {
    this.error = err instanceof Error ? err.message.slice(0, 240) : "Неизвестная ошибка модели";
    this.state = "error";
  }

  private async verify() {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(this.file)) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== SIZE || hash.digest("hex") !== SHA256) throw new Error("Файл GGUF не совпадает с закреплённым размером или SHA-256");
    this.bytes = bytes;
  }

  private async download(signal: AbortSignal) {
    const part = `${this.file}.part`;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
    try {
      const disk = await statfs(this.dir);
      if (disk.bavail * disk.bsize < SIZE + 512 * 1024 * 1024) throw new Error("Недостаточно места для загрузки GGUF");
      const response = await fetch(URL, { signal: deadline, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Не удалось скачать модель: HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (length !== SIZE) throw new Error("Размер загружаемой модели не совпадает с ожидаемым");
      const hash = createHash("sha256");
      await pipeline(response.body, new Transform({ transform: (chunk: Buffer, _encoding, done) => {
        this.bytes += chunk.length;
        if (this.bytes > MAX_BYTES) return done(new Error("Размер GGUF превышает ожидаемый"));
        hash.update(chunk);
        done(null, chunk);
      } }), createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal: deadline });
      this.state = "verifying";
      if (this.bytes !== SIZE || hash.digest("hex") !== SHA256) throw new Error("Контрольная сумма GGUF не совпала");
      await rename(part, this.file);
      await this.startServer();
    } catch (err) {
      await unlink(part).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
      throw err;
    }
  }

  private async startServer() {
    this.state = "starting";
    const child = spawn("/app/llama-server", ["-m", this.file, "-a", this.alias, "--host", "127.0.0.1", "--port", "8080", "-c", "4096", "-ngl", "0", "-t", "16", "--parallel", "1"], {
      stdio: "ignore",
      env: { ...process.env, LD_LIBRARY_PATH: "/app" },
    });
    this.child = child;
    child.on("error", (err) => { this.child = undefined; this.fail(err); });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopping) this.fail(new Error(`Локальная модель остановилась (${signal ?? code})`));
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.stopping) { child.kill("SIGTERM"); throw new Error("Приложение останавливается"); }
      if (child.exitCode !== null || this.child !== child) throw new Error(`Локальная модель не запустилась (код ${child.exitCode ?? "неизвестен"})`);
      try {
        const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(1500) });
        if (response.ok) { this.state = "ready"; return; }
      } catch { /* Model still loading. */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    child.kill("SIGTERM");
    throw new Error("Превышено время ожидания запуска локальной модели");
  }

  async stop() {
    this.stopping = true;
    this.controller?.abort();
    await this.downloadTask;
    this.child?.kill("SIGTERM");
  }
}
