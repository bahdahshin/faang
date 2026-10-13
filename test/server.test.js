import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.js";
import { createStore } from "../lib/store.js";
import { buildAppleSearchUrl } from "../lib/apple.js";

const appleUrl = "https://jobs.apple.com/en-us/search";
const nvidiaUrl = "https://jobs.nvidia.com/careers";
const microsoftUrl = "https://apply.careers.microsoft.com/careers";
const collected = overrides => ({ fetchedAt: new Date().toISOString(), pagesFetched: 1, pagesRequested: 2, totalResults: 1,
  jobs: [{ id: "200000001", title: "Software Engineer", url: "https://jobs.apple.com/en-us/details/200000001" }], errors: [], ...overrides });
const legacyCheckpoint = overrides => ({ ...collected(), sourceId: "apple", sourceName: "Apple careers", sourceUrl: appleUrl,
  effectiveUrl: buildAppleSearchUrl(appleUrl), pagesFetched: 50, pagesRequested: 50, totalResults: 1652,
  stoppedEarly: "Page limit reached (50); more Apple search results may be available.",
  detailsFetched: 100, detailsRequested: 100, enrichmentStoppedEarly: "Details limited to the newest 100 roles; remaining salary and experience fields may be unknown.",
  ...overrides });

async function fixture(t, scrape = async () => collected(), options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swe-job-api-"));
  const store = createStore({ dir });
  const server = createApp({ store, scrape, pages: 2, timeBudgetMs: 1000, ...options });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { store, server, request: (route, options) => fetch(base + route, options), base };
}

const jsonBody = (value, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const streamEvents = async response => (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("source API returns a catalog and persists source CRUD", async t => {
  const { request, store } = await fixture(t);
  const catalogResponse = await request("/api/sources");
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.deepEqual(catalog.supportedProviders, ["apple", "nvidia", "microsoft"]);
  assert.equal(catalog.sources[0].url, appleUrl);
  const addedResponse = await request("/api/sources", jsonBody({ name: "Apple USA", url: `${appleUrl}?location=usa`, enabled: false }));
  assert.equal(addedResponse.status, 201);
  const added = await addedResponse.json();
  const patchResponse = await request(`/api/sources/${added.id}`, jsonBody({ enabled: true, name: "Apple US engineering" }, "PATCH"));
  assert.equal(patchResponse.status, 200);
  assert.equal((await patchResponse.json()).enabled, true);
  assert.equal((await store.sources()).find(source => source.id === added.id).name, "Apple US engineering");
  const deletion = await request(`/api/sources/${added.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deleted: true });
  const missing = await request(`/api/sources/${added.id}`, { method: "DELETE" });
  assert.equal(missing.status, 404);
  await missing.json();
});

test('the default refresh fetches every enabled provider and combines same-ID roles from different companies', async t => {
  const calls = [];
  const {request, store} = await fixture(t, async options => {
    calls.push(options.provider);
    return collected({ jobs:[{id:'123456789',title:'Software Engineer',company:{apple:'Apple',nvidia:'NVIDIA',microsoft:'Microsoft'}[options.provider]}] });
  });
  const nvidia = await store.addSource({name:'NVIDIA US',url:nvidiaUrl});
  const microsoft = await store.addSource({name:'Microsoft US',url:microsoftUrl});
  await store.addSource({name:'Disabled',url:`${appleUrl}?search=disabled`,enabled:false});
  const events = await streamEvents(await request('/api/refresh', {method:'POST'}));
  assert.deepEqual(calls,['apple','nvidia','microsoft']);
  assert.equal(events.filter(event=>event.type==='source_done').length,3);
  const done=events.find(event=>event.type==='done').fetch;
  assert.equal(done.scope,'all');assert.equal(done.jobCount,3);assert.equal(done.partial,false);
  const combined=await (await request('/api/jobs')).json();
  assert.deepEqual(combined.jobs.map(job=>job.company).sort(),['Apple','Microsoft','NVIDIA']);
  assert.equal(combined.sourceCoverage.length,3);
  const single=await (await request(`/api/jobs?source=${nvidia.id}`)).json();
  assert.equal(single.provider,'nvidia');assert.equal(single.jobs[0].company,'NVIDIA');
  const microsoftSingle=await (await request(`/api/jobs?source=${microsoft.id}`)).json();
  assert.equal(microsoftSingle.provider,'microsoft');assert.equal(microsoftSingle.jobs[0].company,'Microsoft');
});

test('Microsoft source API forces US scope and rejects conflicting locations without changing saved settings', async t => {
  const { request, store } = await fixture(t);
  const response = await request('/api/sources', jsonBody({ name: 'Microsoft US', url: microsoftUrl }));
  assert.equal(response.status, 201);
  const added = await response.json();
  assert.equal(added.provider, 'microsoft');
  assert.equal(added.url, `${microsoftUrl}?location=United+States`);
  const duplicate = await request('/api/sources', jsonBody({ name: 'Microsoft duplicate', url: `${microsoftUrl}?location=United%20States` }));
  assert.equal(duplicate.status, 409);
  await duplicate.json();
  for (const url of [`${microsoftUrl}?location=India`, `${microsoftUrl}?country=Canada`, `${microsoftUrl}?countryCode=CA`,
    `${microsoftUrl}?country_code=CA`, 'https://apply.careers.microsoft.com.evil.example/careers',
    'http://apply.careers.microsoft.com/careers', 'https://user@apply.careers.microsoft.com/careers',
    'https://apply.careers.microsoft.com:444/careers']) {
    const rejected = await request(`/api/sources/${added.id}`, jsonBody({ url }, 'PATCH'));
    assert.equal(rejected.status, 400, url);
    assert.equal(typeof (await rejected.json()).error, 'string');
  }
  assert.equal((await store.sources()).find(source => source.id === added.id).url, added.url);
});

test('all-source refresh retains previous jobs after one failure and still fetches the other source',async t=>{
  const calls=[];
  const {request,store}=await fixture(t,async options=>{
    calls.push(options.provider);
    if(options.provider==='apple')throw new Error('Temporary Apple outage');
    return collected({jobs:[{id:'987654321',title:'Software Engineer',company:'NVIDIA'}]});
  });
  await store.save({...collected(),sourceId:'apple',provider:'apple',sourceName:'Apple',sourceUrl:appleUrl});
  await store.addSource({name:'NVIDIA US',url:nvidiaUrl});
  const events=await streamEvents(await request('/api/refresh?source=all',{method:'POST'}));
  assert.deepEqual(calls,['apple','nvidia']);assert.ok(events.some(event=>event.type==='source_error'&&event.sourceId==='apple'));
  const result=events.find(event=>event.type==='done').fetch;
  assert.equal(result.jobCount,2);assert.equal(result.partial,true);
  assert.equal((await store.sources())[0].lastStatus,'error');
  assert.equal((await store.sources())[1].lastStatus,'success');
});

test('combined dashboard omits disabled and deleted sources while keeping history readable',async t=>{
  const {request,store}=await fixture(t);
  const apple=await store.save({...collected(),sourceId:'apple',provider:'apple',sourceUrl:appleUrl});
  const nvidia=await store.addSource({name:'NVIDIA US',url:nvidiaUrl,enabled:false});
  await store.save({...collected(),sourceId:nvidia.id,provider:'nvidia',sourceUrl:nvidia.url,jobs:[{id:'999999999',company:'NVIDIA'}]});
  assert.equal((await (await request('/api/jobs')).json()).jobCount,1);
  await store.deleteSource('apple');
  assert.equal((await (await request('/api/jobs')).json()).jobCount,0);
  assert.equal((await request(`/api/fetches/${apple.id}`)).status,200);
});

test("API rejects malformed JSON, incorrect content types, large bodies, and invalid URLs", async t => {
  const { request } = await fixture(t);
  const cases = [
    [{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400],
    [{ method: "POST", body: "{}" }, 415],
    [{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(17000) }) }, 413],
    [jsonBody({ name: "Wrong host", url: "https://example.com/en-us/search" }), 400],
    [jsonBody({ name: "Duplicate", url: appleUrl }), 409],
  ];
  for (const [options, status] of cases) {
    const response = await request("/api/sources", options);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("API returns useful empty states and enforces route methods", async t => {
  const { request } = await fixture(t);
  const history = await request("/api/fetches");
  assert.deepEqual(await history.json(), { storage: "files", defaultId: 'all', fetches: [] });
  const jobs = await request("/api/jobs");
  assert.equal(jobs.status, 200);
  const empty = await jobs.json();
  assert.equal(empty.scope, 'all');
  assert.deepEqual(empty.jobs, []);
  assert.equal(empty.sourceCoverage[0].jobCount, 0);
  for (const [route, method, status] of [
    ["/api/sources", "PUT", 405], ["/api/sources/apple", "GET", 405],
    ["/api/refresh", "GET", 405], ["/api/fetches", "POST", 405],
    ["/api/fetches/missing", "GET", 404], ["/api/unknown", "GET", 404],
  ]) {
    const response = await request(route, { method });
    assert.equal(response.status, status, `${method} ${route}`);
    await response.json();
  }
});

test("refresh streams progress and completion, saves history, and records source status", async t => {
  let received;
  const { request } = await fixture(t, async options => { received = options; options.onProgress("Fetched page 1"); return collected(); });
  const response = await request("/api/refresh?source=apple", { method: "POST" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const events = await streamEvents(response);
  assert.ok(events.some(event => event.type === "progress" && event.message === "Fetched page 1"));
  const done = events.find(event => event.type === "done");
  assert.equal(done.fetch.jobCount, 1);
  assert.equal(done.fetch.partial, false);
  assert.equal(received.url, appleUrl);
  assert.equal(received.pages, 2);
  assert.equal(received.timeBudgetMs, 1000);
  assert.ok(received.signal instanceof AbortSignal);
  const history = await (await request("/api/fetches")).json();
  assert.equal(history.defaultId, "all");
  const jobs = await (await request("/api/jobs?source=apple")).json();
  assert.equal(jobs.sourceId, "apple");
  assert.equal(jobs.sourceUrl, appleUrl);
  assert.equal(jobs.query, "software engineering");
  assert.equal(jobs.jobs[0].title, "Software Engineer");
  const saved = await (await request(`/api/fetches/${done.fetch.id}`)).json();
  assert.deepEqual(saved, jobs);
  const source = (await (await request("/api/sources")).json()).sources[0];
  assert.equal(source.lastStatus, "success");
  assert.equal(source.lastJobCount, 1);
  assert.ok(Number.isFinite(Date.parse(source.lastFetchedAt)));
});

test("disabled and missing sources cannot trigger scraping", async t => {
  let calls = 0;
  const { request, store } = await fixture(t, async () => { calls++; return collected(); });
  await store.editSource("apple", { enabled: false });
  for (const [route, status] of [["/api/refresh?source=apple", 400], ["/api/refresh", 404], ["/api/refresh?source=missing", 404]]) {
    const response = await request(route, { method: "POST" });
    assert.equal(response.status, status);
    await response.json();
  }
  assert.equal(calls, 0);
});

test("a failed fetch keeps the existing snapshot and records an error", async t => {
  const { request, store } = await fixture(t, async () => { throw new Error("Apple request timed out"); });
  const original = await store.save({ ...collected(), source: "apple", sourceId: "apple", sourceName: "Apple careers", sourceUrl: appleUrl });
  const response = await request("/api/refresh?source=apple", { method: "POST" });
  const events = await streamEvents(response);
  assert.equal(events.find(event => event.type === "error").error, "Apple request timed out");
  assert.equal(events.some(event => event.type === "done"), false);
  assert.equal((await store.list()).length, 1);
  assert.equal((await (await request("/api/jobs?source=apple")).json()).id, original.id);
  assert.equal((await store.sources())[0].lastStatus, "error");
});

test("zero-job failures do not create an empty replacement snapshot", async t => {
  const { request, store } = await fixture(t, async () => collected({ jobs: [], errors: [{ page: 1, error: "Apple unavailable" }] }));
  const events = await streamEvents(await request("/api/refresh?source=apple", { method: "POST" }));
  assert.equal(events.find(event => event.type === "error").error, "Apple unavailable");
  assert.deepEqual(await store.list(), []);
});

test("a partial fetch is saved while complete history stays the dashboard default", async t => {
  const { request, store } = await fixture(t, async () => collected({ errors: [{ page: 2, error: "Temporary failure" }] }));
  const original = await store.save({ ...collected(), sourceId: "apple", sourceName: "Apple careers", sourceUrl: appleUrl });
  const events = await streamEvents(await request("/api/refresh?source=apple", { method: "POST" }));
  const partial = events.find(event => event.type === "done").fetch;
  assert.equal(partial.partial, true);
  assert.equal((await store.sources())[0].lastStatus, "partial");
  const history = await (await request("/api/fetches")).json();
  assert.equal(history.fetches.length, 2);
  assert.equal(history.defaultId, "all");
  assert.equal((await (await request("/api/jobs?source=apple")).json()).id, original.id);
  assert.equal((await (await request(`/api/fetches/${partial.id}`)).json()).id, partial.id);
});

test("deleting the general source selects US history while its saved fetch stays accessible", async t => {
  const { request, store } = await fixture(t);
  const usSource = await store.addSource({ name: "Apple careers · US", url: `${appleUrl}?location=united-states-USA` });
  const us = await store.save({ ...collected(), sourceId: usSource.id, sourceName: usSource.name, sourceUrl: usSource.url });
  assert.deepEqual((await (await request("/api/jobs")).json()).jobs.map(job => job.id), ["200000001"]);
  const general = await store.save({ ...collected(), sourceId: "apple", sourceName: "Apple careers", sourceUrl: appleUrl,
    jobs: [{ id: "200000002", title: "Software Engineer", location: "London" }] });
  assert.equal((await (await request("/api/fetches")).json()).defaultId, "all");
  assert.equal((await (await request("/api/jobs")).json()).jobs.length, 2);

  const deletion = await request("/api/sources/apple", { method: "DELETE" });
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deleted: true });
  const history = await (await request("/api/fetches")).json();
  assert.equal(history.defaultId, "all");
  assert.equal(history.fetches.length, 2);
  assert.ok(history.fetches.some(saved => saved.id === general.id));
  const jobs = await (await request("/api/jobs")).json();
  assert.equal(jobs.id, "all");
  assert.equal(jobs.scope, "all");
  assert.deepEqual(jobs.jobs.map(job => job.id), ["200000001"]);
  assert.equal(jobs.jobs[0].sourceId, usSource.id);
  assert.equal((await (await request(`/api/jobs?source=${usSource.id}`)).json()).id, us.id);
  const retained = await request(`/api/fetches/${general.id}`);
  assert.equal(retained.status, 200);
  assert.equal((await retained.json()).jobs[0].location, "London");
});

test("resuming a legacy page cap forwards the saved checkpoint and creates a separate snapshot", async t => {
  let received;
  const { request, store } = await fixture(t, async options => {
    received = options;
    return collected({ pagesFetched: 51, pagesRequested: 500,
      jobs: [...options.resume.jobs, { id: "200000002", title: "Backend Engineer" }],
      detailsFetched: 101, detailsRequested: 101, enrichmentStoppedEarly: null });
  }, { pages: 500 });
  const original = await store.save(legacyCheckpoint());
  const before = await store.load(original.id);
  const events = await streamEvents(await request(`/api/refresh?source=apple&resume=${original.id}`, { method: "POST" }));
  const resumed = events.find(event => event.type === "done")?.fetch;
  assert.ok(resumed, JSON.stringify(events));
  assert.deepEqual(received.resume, before);
  assert.equal(received.url, appleUrl);
  assert.equal(received.pages, 500);
  assert.equal(received.timeBudgetMs, 1000);
  assert.notEqual(resumed.id, original.id);
  assert.equal(resumed.resumedFrom, original.id);
  assert.equal(resumed.jobCount, 2);
  assert.equal(resumed.partial, false);
  assert.equal(resumed.continuation, null);
  assert.equal(resumed.detailsFetched, 101);
  assert.deepEqual(await store.load(original.id), before);
  const history = await (await request("/api/fetches")).json();
  assert.equal(history.fetches.length, 2);
  assert.equal(history.defaultId, "all");
  assert.equal((await (await request(`/api/fetches/${resumed.id}`)).json()).resumedFrom, original.id);
});

test("resume validation rejects missing, unrelated, changed, and completed checkpoints before scraping", async t => {
  let calls = 0;
  const { request, store } = await fixture(t, async () => { calls++; return collected(); }, { pages: 500 });
  const checkpoint = await store.save(legacyCheckpoint());
  const completed = await store.save({ ...legacyCheckpoint(), stoppedEarly: null, continuation: null });
  const other = await store.addSource({ name: "Apple USA", url: `${appleUrl}?location=usa` });
  const cases = [
    ["/api/refresh?source=apple&resume=missing", 404],
    [`/api/refresh?source=${other.id}&resume=${checkpoint.id}`, 400],
    [`/api/refresh?source=apple&resume=${completed.id}`, 400],
  ];
  for (const [route, status] of cases) {
    const result = await request(route, { method: "POST" });
    assert.equal(result.status, status, route);
    assert.equal(typeof (await result.json()).error, "string");
  }
  await store.editSource("apple", { url: `${appleUrl}?search=swift` });
  const changed = await request(`/api/refresh?source=apple&resume=${checkpoint.id}`, { method: "POST" });
  assert.equal(changed.status, 409);
  assert.match((await changed.json()).error, /URL|source|changed/i);
  assert.equal(calls, 0);
  assert.equal((await store.list()).length, 2);
});

test("a failed resume preserves the previous checkpoint for another attempt", async t => {
  const { request, store } = await fixture(t, async () => { throw new Error("Apple request timed out"); }, { pages: 500 });
  const original = await store.save(legacyCheckpoint());
  const before = await store.load(original.id);
  const events = await streamEvents(await request(`/api/refresh?source=apple&resume=${original.id}`, { method: "POST" }));
  assert.equal(events.find(event => event.type === "error")?.error, "Apple request timed out");
  assert.equal(events.some(event => event.type === "done"), false);
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(await store.load(original.id), before);
  assert.equal((await store.sources())[0].lastStatus, "error");
});

test("detail continuation can resume while listing coverage stays complete", async t => {
  let received;
  const { request, store } = await fixture(t, async options => {
    received = options.resume;
    return collected({ pagesFetched: 2, pagesRequested: 500, detailsFetched: 1, detailsRequested: 1,
      continuation: null, enrichmentStoppedEarly: null });
  });
  const original = await store.save(legacyCheckpoint({ pagesFetched: 2, pagesRequested: 500, totalResults: 2,
    stoppedEarly: null, detailsFetched: 0, detailsRequested: 1, enrichmentStoppedEarly: "Fetch time budget reached.",
    continuation: { phase: "details", nextPage: 3, detailsDone: [] },
    resumeState: { detailRoles: [{ id: "200000001", role: { id: "200000001", postingTitle: "Software Engineer", team: { teamCode: "SFTWR" } } }], listingCount: 2 } }));
  assert.equal(original.partial, false);
  assert.equal(original.continuation.phase, "details");
  const events = await streamEvents(await request(`/api/refresh?source=apple&resume=${original.id}`, { method: "POST" }));
  const done = events.find(event => event.type === "done")?.fetch;
  assert.ok(done, JSON.stringify(events));
  assert.equal(received.continuation.phase, "details");
  assert.equal(done.partial, false);
  assert.equal(done.detailsFetched, 1);
  assert.equal(done.enrichmentStoppedEarly, null);
  assert.equal(done.continuation, null);
});

test("resume selects the checkpoint source when a source parameter is omitted", async t => {
  let received;
  const { request, store } = await fixture(t, async options => { received = options; return collected(); }, { pages: 500 });
  const other = await store.addSource({ name: "Apple USA", url: `${appleUrl}?location=usa` });
  const checkpoint = await store.save(legacyCheckpoint({ sourceId: other.id, sourceName: other.name,
    sourceUrl: other.url, effectiveUrl: buildAppleSearchUrl(other.url) }));
  const events = await streamEvents(await request(`/api/refresh?resume=${checkpoint.id}`, { method: "POST" }));
  const done = events.find(event => event.type === "done")?.fetch;
  assert.ok(done, JSON.stringify(events));
  assert.equal(received.url, other.url);
  assert.equal(received.resume.sourceId, other.id);
  assert.equal(done.sourceId, other.id);
  assert.equal((await store.sources()).find(source => source.id === other.id).lastStatus, "success");
  assert.equal((await store.sources()).find(source => source.id === "apple").lastStatus, null);
});

test("a checkpoint beyond the configured page ceiling cannot resume", async t => {
  let calls = 0;
  const { request, store } = await fixture(t, async () => { calls++; return collected(); });
  const checkpoint = await store.save(legacyCheckpoint());
  const result = await request(`/api/refresh?source=apple&resume=${checkpoint.id}`, { method: "POST" });
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /page limit|APPLE_PAGES/i);
  assert.equal(calls, 0);
});

test("a saved cooldown rejects resume with Retry-After before any Apple request", async t => {
  let calls = 0;
  const { request, store } = await fixture(t, async () => { calls++; return collected(); }, { pages: 500 });
  const retryAt = new Date(Date.now() + 60000).toISOString();
  const checkpoint = await store.save(legacyCheckpoint({ continuation: { phase: "search", nextPage: 51,
    detailsDone: [], retryAt } }));
  const result = await request(`/api/refresh?source=apple&resume=${checkpoint.id}`, { method: "POST" });
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get("retry-after")) > 0);
  assert.match((await result.json()).error, /cooldown|retry/i);
  assert.equal(calls, 0);
  assert.equal((await store.list()).length, 1);
});

test('the single-source API saves an initial Microsoft throttle checkpoint and rejects premature resume', async t => {
  let calls = 0;
  const retryAt = new Date(Date.now() + 60000).toISOString();
  const { request, store } = await fixture(t, async options => {
    calls++;
    assert.equal(options.provider, 'microsoft');
    assert.equal(new URL(options.url).searchParams.get('location'), 'United States');
    return collected({ provider: 'microsoft', effectiveUrl: options.url,
      jobs: [], pagesFetched: 0, resultPagesFetched: 0, listingCount: 0,
      pageSize: null, totalResults: null, totalPages: null,
      detailsFetched: 0, detailsRequested: 0, detailsCompleted: 0, detailsRemaining: 0,
      stoppedEarly: 'Microsoft returned HTTP 429.',
      errors: [{ phase: 'search', page: 1, status: 429, error: 'Microsoft returned HTTP 429.', retryAt }],
      continuation: { phase: 'search', nextPage: 1, offset: 0, detailsDone: [], retryAt },
      resumeState: { detailRoles: [], previousIds: '', maxDetails: 1000,
        requestDelayMs: 20000, lastRequestAt: Date.now() },
    });
  });
  const source = await store.addSource({ name: 'Microsoft US', url: microsoftUrl });
  const response = await request(`/api/refresh?source=${source.id}`, { method: 'POST' });
  assert.equal(response.status, 200);
  const events = await streamEvents(response);
  assert.equal(events.some(event => event.type === 'error'), false);
  const done = events.find(event => event.type === 'done')?.fetch;
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.jobCount, 0);
  assert.equal(done.partial, true);
  assert.equal(done.pagesFetched, 0);
  assert.deepEqual(done.continuation, { phase: 'search', nextPage: 1, offset: 0, detailsDone: [], retryAt });

  const history = await (await request('/api/fetches')).json();
  assert.equal(history.fetches.length, 1);
  assert.equal(history.fetches[0].id, done.id);
  assert.equal(history.fetches[0].continuation.retryAt, retryAt);
  const saved = await (await request(`/api/fetches/${done.id}`)).json();
  assert.equal(saved.resumeState.requestDelayMs, 20000);
  assert.deepEqual(saved.jobs, []);
  assert.equal(saved.continuation.offset, 0);
  const recorded = (await store.sources()).find(item => item.id === source.id);
  assert.equal(recorded.lastStatus, 'partial');
  assert.equal(recorded.lastJobCount, 0);

  const premature = await request(`/api/refresh?source=${source.id}&resume=${done.id}`, { method: 'POST' });
  assert.equal(premature.status, 429);
  assert.ok(Number(premature.headers.get('retry-after')) > 0);
  assert.match((await premature.json()).error, /cooldown|retry/i);
  assert.equal(calls, 1);
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(await store.load(done.id), saved);
});

test("concurrent refresh requests are rejected and the lock clears after completion", async t => {
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const { request } = await fixture(t, async () => { calls++; if (calls === 1) await pending; return collected(); });
  const first = await request("/api/refresh", { method: "POST" });
  try {
    const second = await request("/api/refresh", { method: "POST" });
    assert.equal(second.status, 409);
    await second.json();
    assert.equal(calls, 1);
  } finally { release(); }
  assert.ok((await streamEvents(first)).some(event => event.type === "done"));
  const next = await request("/api/refresh", { method: "POST" });
  assert.equal(next.status, 200);
  assert.ok((await streamEvents(next)).some(event => event.type === "done"));
  assert.equal(calls, 2);
});

test("cross-origin writes are rejected while same-origin source changes work", async t => {
  const { request, base } = await fixture(t);
  const forbidden = await request("/api/sources/apple", { ...jsonBody({ enabled: false }, "PATCH"), headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" } });
  assert.equal(forbidden.status, 403);
  await forbidden.json();
  const wrongScheme = await request("/api/sources/apple", { ...jsonBody({ enabled: false }, "PATCH"), headers: { "Content-Type": "application/json", Origin: base.replace("http:", "https:") } });
  assert.equal(wrongScheme.status, 403);
  await wrongScheme.json();
  const allowed = await request("/api/sources/apple", { ...jsonBody({ enabled: false }, "PATCH"), headers: { "Content-Type": "application/json", Origin: base } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).enabled, false);
});
