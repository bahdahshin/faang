import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, defaultFetch, ApiError } from "./lib/store.js";
import { scrapeSource, continuationFor, supportedProviders } from "./lib/providers.js";
import { collectEnabledSources } from "./lib/collect.js";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL("./data", import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const json = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };

async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new ApiError(415, "Use application/json.");
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new ApiError(413, "Request body too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Invalid JSON body."); }
}

export function createApp({ store = createStore({ dir: DATA_DIR }), scrape = scrapeSource,
  pages = Number(process.env.APPLE_PAGES || 500), timeBudgetMs = Number(process.env.APPLE_TIME_BUDGET_MS || 240000) } = {}) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 500) throw new Error("APPLE_PAGES must be an integer between 1 and 500.");
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 1000 || timeBudgetMs > 1800000) throw new Error("APPLE_TIME_BUDGET_MS must be between 1000 and 1800000.");
  let running = false;
  async function api(req, res, url) {
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.origin).origin === `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`; } catch {}
      if (!sameOrigin) throw new ApiError(403, "Cross-origin changes are not allowed.");
    }
    if (url.pathname === "/api/sources") {
      if (req.method === "GET") return json(res, 200, { sources: await store.sources(), supportedProviders });
      if (req.method === "POST") return json(res, 201, await store.addSource(await body(req)));
      throw new ApiError(405, "Use GET or POST.");
    }
    const sourceMatch = url.pathname.match(/^\/api\/sources\/([\w-]+)$/);
    if (sourceMatch) {
      if (req.method === "PATCH") return json(res, 200, await store.editSource(sourceMatch[1], await body(req)));
      if (req.method === "DELETE") return json(res, 200, await store.deleteSource(sourceMatch[1]));
      throw new ApiError(405, "Use PATCH or DELETE.");
    }
    if (url.pathname === "/api/refresh") {
      if (req.method !== "POST") throw new ApiError(405, "Use POST to fetch jobs.");
      if (running) throw new ApiError(409, "A fetch is already running. Wait for it to finish.");
      if (process.env.VERCEL && !process.env.DATA_DIR) throw new ApiError(503, "Fetching needs persistent writable storage. Run locally or configure DATA_DIR on a persistent host.");
      const resumeId = url.searchParams.get("resume");
      const resume = resumeId ? await store.load(resumeId) : null;
      if (resumeId && !resume) throw new ApiError(404, "Saved fetch not found.");
      const sources = await store.sources();
      const sourceId = url.searchParams.get("source") || resume?.sourceId;
      const allRequested = !resumeId && (!sourceId || sourceId === 'all');
      if (sourceId === 'all' && resumeId) throw new ApiError(400, 'Resume a specific source checkpoint.');
      if (allRequested && !sources.some(source => source.enabled)) throw new ApiError(404, 'Add or enable a scraping source first.');
      const source = sourceId ? sources.find(s => s.id === sourceId) : sources.find(s => s.enabled);
      if (!allRequested && !source) throw new ApiError(404, sourceId ? "Source not found." : "Add or enable a scraping source first.");
      if (!allRequested && !source.enabled) throw new ApiError(400, "Enable this source before fetching.");
      if (resume) {
        if (resume.sourceId !== source.id) throw new ApiError(400, "This saved fetch belongs to a different source.");
        if (resume.sourceUrl !== source.url) throw new ApiError(409, "The source URL changed. Start a new fetch for the updated search.");
        const continuation = continuationFor(resume);
        if (!continuation) throw new ApiError(400, "This fetch cannot be resumed. Start a new fetch.");
        if (continuation.phase === "search" && continuation.nextPage > pages) throw new ApiError(400, "The saved fetch reached the configured page limit. Increase APPLE_PAGES to continue.");
        const retryAt = Date.parse(continuation.retryAt);
        if (Number.isFinite(retryAt) && retryAt > Date.now()) {
          res.setHeader("Retry-After", String(Math.ceil((retryAt - Date.now()) / 1000)));
          throw new ApiError(429, `${source.name} requested a cooldown. Resume after the indicated retry time.`);
        }
      }
      // Recheck after the async source read, before acquiring the lock.
      if (running) throw new ApiError(409, "A fetch is already running. Wait for it to finish.");
      running = true;
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const send = event => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", onClose);
      const heartbeat = setInterval(() => send({ type: "ping" }), 15000);
      try {
        if (allRequested) {
          send({ type: 'progress', message: 'Fetching all enabled software engineering sources…' });
          const aggregate = await collectEnabledSources({ store, sources, scrape, pages, timeBudgetMs, signal: controller.signal, onEvent: send });
          if (!controller.signal.aborted) { const { jobs, ...summary } = aggregate; send({ type: 'done', fetch: summary }); }
          return;
        }
        send({ type: "progress", message: resume ? `Resuming ${source.name} from its saved checkpoint…` : `Fetching software engineering roles from ${source.name}…` });
        const data = await scrape({ url: source.url, provider: source.provider, sourceId: source.id, pages, timeBudgetMs, resume, signal: controller.signal, onProgress: message => send({ type: "progress", message }) });
        if (controller.signal.aborted) return;
        const hasCheckpoint = continuationFor({ ...data, sourceUrl: source.url });
        if (!data.jobs.length && (data.errors?.length || data.stoppedEarly) && !hasCheckpoint) throw new Error(data.errors?.[0]?.error || data.stoppedEarly || "No jobs collected.");
        const summary = await store.save({ ...data, resumedFrom: resume?.id ?? null, provider: source.provider, source: source.provider, sourceId: source.id, sourceName: source.name, sourceUrl: source.url, query: "software engineering" });
        await store.recordFetch(source.id, { status: summary.partial ? "partial" : "success", jobCount: summary.jobCount });
        send({ type: "done", fetch: summary });
      } catch (error) {
        if (!controller.signal.aborted) {
          if (source) await store.recordFetch(source.id, { status: "error" }).catch(() => {});
          send({ type: "error", error: error.message });
        }
      } finally {
        clearInterval(heartbeat); res.off("close", onClose); running = false;
        if (!res.writableEnded) res.end();
      }
      return;
    }
    if (req.method !== "GET") throw new ApiError(405, "Use GET.");
    if (url.pathname === "/api/fetches") {
      const [fetches, catalog] = await Promise.all([store.list(), store.sources()]);
      return json(res, 200, { storage: store.kind, defaultId: 'all', fetches });
    }
    if (url.pathname === "/api/jobs") {
      const sourceId = url.searchParams.get('source');
      if (!sourceId || sourceId === 'all') return json(res, 200, await store.aggregate());
      const [fetches, catalog] = await Promise.all([store.list(), store.sources()]);
      const selected = defaultFetch(fetches, catalog.filter(source => source.id === sourceId).map(source => source.id));
      if (!selected) return json(res, 404, { empty: true, error: "No saved fetches for this source yet. Use Fetch all sources to collect jobs." });
      return json(res, 200, await store.load(selected.id));
    }
    const match = url.pathname.match(/^\/api\/fetches\/([\w-]+)$/);
    if (match) {
      if (match[1] === 'all') return json(res, 200, await store.aggregate());
      const data = await store.load(match[1]);
      if (!data) throw new ApiError(404, "Fetch not found.");
      return json(res, 200, data);
    }
    throw new ApiError(404, "Unknown API route.");
  }
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (!["GET", "HEAD"].includes(req.method)) throw new ApiError(405, "Use GET or HEAD.");
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new ApiError(403, "Forbidden.");
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || (error.code === "ENOENT" ? 404 : 500), { error: error.message });
      else if (!res.writableEnded) res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`Software Engineer Job Market: http://localhost:${port}`));
}
