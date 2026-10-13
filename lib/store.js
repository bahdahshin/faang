import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { continuationFor, sourceSearchUrl } from "./providers.js";

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const DEFAULT_SOURCE = {
  id: "apple", name: "Apple careers", url: "https://jobs.apple.com/en-us/search",
  provider: "apple", enabled: true, lastFetchedAt: null, lastStatus: null, lastJobCount: null,
};

export function validateSource(input, previous) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, "Expected a source object.");
  const name = input.name ?? previous?.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new ApiError(400, "Source name must be 1–100 characters.");
  let search;
  try { search = sourceSearchUrl(input.url ?? previous?.url); } catch (error) { throw new ApiError(400, error.message); }
  if (input.provider && input.provider !== search.provider) throw new ApiError(400, "The provider does not match the careers URL.");
  if (input.enabled != null && typeof input.enabled !== "boolean") throw new ApiError(400, "Enabled must be true or false.");
  return { ...previous, id: previous?.id ?? randomUUID(), name: name.trim(), url: search.url, provider: search.provider, enabled: input.enabled ?? previous?.enabled ?? true,
    lastFetchedAt: previous?.lastFetchedAt ?? null, lastStatus: previous?.lastStatus ?? null, lastJobCount: previous?.lastJobCount ?? null };
}

export function summarize(data) {
  const failedPages = (data.errors ?? []).filter(error => error.phase !== "details").length;
  return { id: data.id, fetchedAt: data.fetchedAt, jobCount: data.jobs.length,
    pagesFetched: data.pagesFetched, pagesRequested: data.pagesRequested,
    resultPagesFetched: data.resultPagesFetched ?? null, totalPages: data.totalPages ?? null,
    pageSize: data.pageSize ?? null, listingCount: data.listingCount ?? null,
    effectiveUrl: data.effectiveUrl ?? null,
    failedPages, failedDetails: (data.errors ?? []).filter(error => error.phase === "details").length,
    partial: Boolean(failedPages || data.stoppedEarly),
    stoppedEarly: data.stoppedEarly || null, totalResults: data.totalResults ?? null,
    continuation: continuationFor(data), resumedFrom: data.resumedFrom ?? null,
    detailsFetched: data.detailsFetched ?? 0, detailsRequested: data.detailsRequested ?? 0,
    detailsCompleted: data.detailsCompleted ?? data.detailsFetched ?? 0,
    detailsRemaining: data.detailsRemaining ?? Math.max(0, (data.detailsRequested ?? 0) - (data.detailsFetched ?? 0)),
    enrichmentStoppedEarly: data.enrichmentStoppedEarly ?? null,
    provider: data.provider ?? data.source ?? 'apple', sourceId: data.sourceId, sourceName: data.sourceName, sourceUrl: data.sourceUrl };
}

export function aggregateSnapshots(snapshots, sources) {
  const ordered = [...snapshots].sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const jobs = new Map(), sourceCoverage = [], errors = [];
  let fetchedAt = null;
  for (const source of sources.filter(source => source.enabled)) {
    const matching = ordered.filter(data => data.sourceId === source.id && data.sourceUrl === source.url);
    const data = matching.find(data => !summarize(data).partial) ?? matching[0];
    const summary = data ? summarize(data) : null;
    const latest = matching[0] ? summarize(matching[0]) : null;
    const error = source.lastStatus === 'error' ? 'The latest fetch failed; previous saved jobs are retained.' : !data ? 'This source has not been fetched yet.' : null;
    if (error) errors.push({ sourceId: source.id, sourceName: source.name, error });
    sourceCoverage.push({ ...(summary || {}), sourceId: source.id, sourceName: source.name, provider: source.provider,
      sourceUrl: source.url, fetchId: data?.id ?? null, jobCount: data?.jobs.length ?? 0,
      partial: summary?.partial ?? true, error, continuation: latest?.continuation ?? null });
    if (!data) continue;
    if (!fetchedAt || data.fetchedAt > fetchedAt) fetchedAt = data.fetchedAt;
    for (const job of data.jobs) jobs.set(`${source.provider}:${job.id || job.url}`, { ...job, sourceId: source.id, provider: source.provider });
  }
  const combined = [...jobs.values()].sort((a,b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  return { id: 'all', scope: 'all', sourceName: 'All enabled sources', jobs: combined, jobCount: combined.length,
    sourceCoverage, errors, partial: sourceCoverage.some(source => source.partial || source.error || source.continuation?.phase === 'search'), fetchedAt };
}

export function defaultFetch(summaries, sourceIds) {
  const available = sourceIds ? summaries.filter(summary => sourceIds.includes(summary.sourceId)) : summaries;
  return available.find(summary => !summary.partial) ?? available[0] ?? null;
}

export function createStore({ dir }) {
  const fetchDir = path.join(dir, "fetches");
  const sourceFile = path.join(dir, "sources.json");
  let mutations = Promise.resolve();
  const serialize = (operation) => {
    const current = mutations.then(operation);
    mutations = current.catch(() => {});
    return current;
  };
  async function atomicJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, file);
  }
  async function readSources() {
    try { return JSON.parse(await readFile(sourceFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return [{ ...DEFAULT_SOURCE }]; throw error; }
  }
  async function updateSources(change) {
    return serialize(async () => {
      const sources = await readSources();
      const result = change(sources);
      await atomicJson(sourceFile, sources);
      return result;
    });
  }
  async function readFetches() {
    let names;
    try { names = await readdir(fetchDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(path.join(fetchDir, name), 'utf8'))));
  }
  return {
    kind: "files",
    sources: readSources,
    addSource(input) { return updateSources(sources => {
      if (sources.length >= 100) throw new ApiError(400, "The source list is limited to 100 entries.");
      const source = validateSource(input);
      if (sources.some(s => s.url === source.url)) throw new ApiError(409, "This search URL is already in the source list.");
      sources.push(source); return source;
    }); },
    editSource(id, input) { return updateSources(sources => {
      const index = sources.findIndex(s => s.id === id);
      if (index < 0) throw new ApiError(404, "Source not found.");
      const source = validateSource(input, sources[index]);
      if (sources.some(s => s.id !== id && s.url === source.url)) throw new ApiError(409, "This search URL is already in the source list.");
      sources[index] = source; return source;
    }); },
    deleteSource(id) { return updateSources(sources => {
      const index = sources.findIndex(s => s.id === id);
      if (index < 0) throw new ApiError(404, "Source not found.");
      sources.splice(index, 1); return { deleted: true };
    }); },
    recordFetch(id, result) { return updateSources(sources => {
      const source = sources.find(s => s.id === id);
      if (source) Object.assign(source, { lastFetchedAt: new Date().toISOString(), lastStatus: result.status, lastJobCount: result.jobCount ?? null });
      return source;
    }); },
    async save(data) {
      const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
      const snapshot = { ...data, id, errors: data.errors ?? [] };
      await atomicJson(path.join(fetchDir, `${id}.json`), snapshot);
      return summarize(snapshot);
    },
    async load(id) {
      if (!/^[\w-]{1,100}$/.test(id)) return null;
      try {
        const data = JSON.parse(await readFile(path.join(fetchDir, `${id}.json`), "utf8"));
        return { ...data, continuation: continuationFor(data) };
      }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async list() {
      const data = await readFetches();
      return data.map(summarize).sort((a, b) => b.id.localeCompare(a.id));
    },
    async aggregate() {
      const [snapshots, sources] = await Promise.all([readFetches(), readSources()]);
      return aggregateSnapshots(snapshots, sources);
    },
  };
}
