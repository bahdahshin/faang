import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore, defaultFetch, validateSource } from "../lib/store.js";
import { buildAppleSearchUrl } from "../lib/apple.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swe-job-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: createStore({ dir }) };
}

function snapshot(overrides = {}) {
  return {
    fetchedAt: new Date().toISOString(), source: "apple", sourceId: "apple",
    sourceName: "Apple careers", sourceUrl: "https://jobs.apple.com/en-us/search",
    query: "software engineering", pagesFetched: 1, pagesRequested: 1,
    totalResults: 1, jobs: [{ id: "200000001", title: "Software Engineer", location: "Cupertino" }],
    errors: [], ...overrides,
  };
}

test("sources persist through add, edit, fetch status, delete, and reopening", async t => {
  const { dir, store } = await fixture(t);
  assert.equal((await store.sources())[0].id, "apple");
  const added = await store.addSource({ name: "  Apple in California  ", url: "https://jobs.apple.com/en-us/search?location=california#discard", enabled: false });
  assert.equal(added.name, "Apple in California");
  assert.equal(added.url, "https://jobs.apple.com/en-us/search?location=california");
  assert.equal(added.provider, "apple");
  assert.equal(added.enabled, false);
  const reopened = createStore({ dir });
  assert.deepEqual((await reopened.sources())[1], added);
  const edited = await reopened.editSource(added.id, { name: "California software roles", enabled: true });
  assert.equal(edited.id, added.id);
  assert.equal(edited.url, added.url);
  await reopened.recordFetch(added.id, { status: "partial", jobCount: 3 });
  const recorded = (await createStore({ dir }).sources()).find(source => source.id === added.id);
  assert.equal(recorded.lastStatus, "partial");
  assert.equal(recorded.lastJobCount, 3);
  assert.ok(Number.isFinite(Date.parse(recorded.lastFetchedAt)));
  await reopened.deleteSource(added.id);
  assert.deepEqual((await createStore({ dir }).sources()).map(source => source.id), ["apple"]);
  await assert.rejects(reopened.editSource(added.id, { enabled: true }), { status: 404 });
  await assert.rejects(reopened.deleteSource(added.id), { status: 404 });
});

test("source URLs only accept the supported Apple HTTPS search endpoint", () => {
  const rejected = [
    "http://jobs.apple.com/en-us/search", "ftp://jobs.apple.com/en-us/search",
    "https://example.com/en-us/search", "https://jobs.apple.com.evil.example/en-us/search",
    "https://jobs.apple.com:444/en-us/search", "https://user:password@jobs.apple.com/en-us/search",
    "https://user@jobs.apple.com/en-us/search", "https://jobs.apple.com/en-us/details/200000001",
    "https://jobs.apple.com/en-us/search/", "https://jobs.apple.com/en-gb/search", "not a URL",
  ];
  for (const url of rejected) {
    assert.throws(() => validateSource({ name: "Apple", url }), { status: 400 }, url);
  }
  const valid = validateSource({ name: "Apple", url: "https://jobs.apple.com/en-us/search?search=software%20engineer&location=usa" });
  assert.equal(valid.provider, "apple");
  assert.equal(valid.enabled, true);
});

test("invalid source objects, names, and enabled values are rejected", () => {
  for (const input of [null, [], "source", {}, { name: "" }, { name: "   " }, { name: 7 }, { name: "x".repeat(101) }]) {
    assert.throws(() => validateSource(input), { status: 400 });
  }
  for (const enabled of ["true", "false", 0, 1, {}, []]) {
    assert.throws(() => validateSource({ name: "Apple", url: "https://jobs.apple.com/en-us/search", enabled }), { status: 400 });
  }
});

test('NVIDIA sources persist a canonical US-only URL and reject geographic overrides',async t=>{
  const {store}=await fixture(t);
  const added=await store.addSource({name:'NVIDIA US',url:'https://jobs.nvidia.com/careers'});
  assert.equal(added.provider,'nvidia');assert.equal(new URL(added.url).searchParams.get('location'),'United States');
  await assert.rejects(store.addSource({name:'Duplicate',url:'https://jobs.nvidia.com/careers?location=United%20States'}),{status:409});
  for(const url of ['https://jobs.nvidia.com/careers?location=India','https://jobs.nvidia.com/careers?country=Canada','http://jobs.nvidia.com/careers','https://jobs.nvidia.com.evil.example/careers'])assert.throws(()=>validateSource({name:'NVIDIA',url}),{status:400});
  assert.throws(()=>validateSource({name:'NVIDIA',url:'https://jobs.nvidia.com/careers',provider:'apple'}),{status:400});
});

test('Microsoft sources persist US-only scope, canonical duplicates, and reject unsafe geographic edits', async t => {
  const { store, dir } = await fixture(t);
  const base = 'https://apply.careers.microsoft.com/careers';
  const added = await store.addSource({ name: 'Microsoft US', url: base });
  assert.equal(added.provider, 'microsoft');
  assert.equal(added.url, `${base}?location=United+States`);
  assert.deepEqual((await createStore({ dir }).sources()).find(source => source.id === added.id), added);
  await assert.rejects(store.addSource({ name: 'Duplicate Microsoft US', url: `${base}?location=United%20States` }), { status: 409 });
  for (const url of [`${base}?location=India`, `${base}?country=Canada`, `${base}?countryCode=CA`, `${base}?country_code=CA`,
    'https://apply.careers.microsoft.com.evil.example/careers', 'http://apply.careers.microsoft.com/careers',
    'https://user:password@apply.careers.microsoft.com/careers', 'https://apply.careers.microsoft.com:444/careers']) {
    await assert.rejects(store.editSource(added.id, { url }), { status: 400 }, url);
  }
  assert.throws(() => validateSource({ name: 'Wrong provider', url: base, provider: 'nvidia' }), { status: 400 });
  assert.equal((await store.sources()).find(source => source.id === added.id).url, added.url);
});

test("duplicate URLs are rejected on add and edit without losing source records", async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.addSource({ name: "Duplicate", url: "https://jobs.apple.com/en-us/search#anything" }), { status: 409 });
  const added = await store.addSource({ name: "Filtered", url: "https://jobs.apple.com/en-us/search?location=usa" });
  await assert.rejects(store.editSource(added.id, { url: "https://jobs.apple.com/en-us/search" }), { status: 409 });
  const sources = await store.sources();
  assert.equal(sources.length, 2);
  assert.equal(sources[1].url, added.url);
});

test("concurrent source mutations keep both additions and recover after rejection", async t => {
  const { store } = await fixture(t);
  const input = suffix => ({ name: suffix, url: `https://jobs.apple.com/en-us/search?location=${suffix}` });
  await Promise.all([store.addSource(input("usa")), store.addSource(input("canada"))]);
  await assert.rejects(store.addSource(input("usa")), { status: 409 });
  await store.addSource(input("uk"));
  assert.equal((await store.sources()).length, 4);
});

test("history stores separate immutable snapshots and prefers complete results", async t => {
  const { dir, store } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  assert.equal(defaultFetch([]), null);
  const complete = await store.save(snapshot());
  const partial = await store.save(snapshot({ pagesFetched: 1, pagesRequested: 2, errors: [{ page: 2, error: "Timeout" }], jobs: [{ id: "200000002", title: "Backend Engineer" }] }));
  assert.notEqual(complete.id, partial.id);
  assert.equal(complete.partial, false);
  assert.equal(partial.partial, true);
  assert.equal(partial.failedPages, 1);
  const rawBefore = await readFile(path.join(dir, "fetches", `${complete.id}.json`), "utf8");
  const selected = await store.load(complete.id);
  selected.jobs[0].title = "Modified in memory";
  await store.deleteSource("apple");
  const reopened = createStore({ dir });
  assert.equal((await reopened.load(complete.id)).jobs[0].title, "Software Engineer");
  assert.equal(await readFile(path.join(dir, "fetches", `${complete.id}.json`), "utf8"), rawBefore);
  const history = await reopened.list();
  assert.equal(history.length, 2);
  assert.equal(defaultFetch([partial, complete]).id, complete.id);
  assert.equal(defaultFetch([partial]).id, partial.id);
  assert.equal(defaultFetch(history).id, complete.id);
});

test("time-budget stops are partial and unsafe snapshot IDs cannot escape storage", async t => {
  const { store } = await fixture(t);
  const saved = await store.save(snapshot({ stoppedEarly: "Time budget reached" }));
  assert.equal(saved.partial, true);
  assert.equal(saved.stoppedEarly, "Time budget reached");
  for (const id of ["../sources", "..\\sources", "/sources", "a/b", "a\\b", "", "x".repeat(101), "missing"]) {
    assert.equal(await store.load(id), null, id);
  }
});

test("a completed short search with detail errors still has complete listing coverage", async t => {
  const { store } = await fixture(t);
  const saved = await store.save(snapshot({ pagesFetched: 2, pagesRequested: 50,
    errors: [{ phase: "details", roleId: "200000001", error: "Not found" }] }));
  assert.equal(saved.partial, false);
  assert.equal(saved.failedPages, 0);
  assert.equal(saved.failedDetails, 1);
});

test("legacy page-limit checkpoints expose continuation and detail coverage without rewriting history", async t => {
  const { dir, store } = await fixture(t);
  const saved = await store.save(snapshot({ pagesFetched: 50, pagesRequested: 50, totalResults: 1652,
    effectiveUrl: buildAppleSearchUrl("https://jobs.apple.com/en-us/search"),
    stoppedEarly: "Page limit reached (50); more Apple search results may be available.",
    detailsFetched: 100, detailsRequested: 100,
    enrichmentStoppedEarly: "Details limited to the newest 100 roles; remaining salary and experience fields may be unknown." }));
  assert.equal(saved.partial, true);
  assert.equal(saved.continuation.phase, "search");
  assert.equal(saved.continuation.nextPage, 51);
  assert.equal(saved.continuation.listingsSeen, null);
  assert.equal(saved.detailsFetched, 100);
  assert.equal(saved.detailsRequested, 100);
  assert.match(saved.enrichmentStoppedEarly, /newest 100/);
  assert.equal(saved.resumedFrom, null);
  const file = path.join(dir, "fetches", `${saved.id}.json`);
  const raw = await readFile(file, "utf8");
  const loaded = await createStore({ dir }).load(saved.id);
  assert.equal(loaded.continuation.nextPage, 51);
  const history = await createStore({ dir }).list();
  assert.deepEqual(history[0].continuation, saved.continuation);
  assert.equal(await readFile(file, "utf8"), raw);
  assert.equal(JSON.parse(raw).continuation, undefined, "Legacy history must be upgraded only in memory.");
});

test("listing completion and detail progress remain separate in checkpoint summaries", async t => {
  const { store } = await fixture(t);
  const saved = await store.save(snapshot({ detailsFetched: 2, detailsRequested: 10,
    enrichmentStoppedEarly: "Fetch time budget reached.", resumedFrom: "earlier-checkpoint",
    continuation: null, errors: [{ phase: "details", roleId: "200000001", error: "Timeout" }] }));
  assert.equal(saved.partial, false);
  assert.equal(saved.failedPages, 0);
  assert.equal(saved.failedDetails, 1);
  assert.equal(saved.detailsFetched, 2);
  assert.equal(saved.detailsRequested, 10);
  assert.equal(saved.enrichmentStoppedEarly, "Fetch time budget reached.");
  assert.equal(saved.resumedFrom, "earlier-checkpoint");
  assert.equal(saved.continuation, null);
  assert.deepEqual((await store.list())[0], saved);
});

test("fetch summaries preserve the actual search and listing coverage", async t => {
  const { store } = await fixture(t);
  const coverage = { effectiveUrl: "https://jobs.apple.com/en-us/search?location=united-states-USA&sort=newest&page=1",
    listingCount: 4120, totalResults: 4120, pageSize: 20, totalPages: 206,
    pagesFetched: 206, resultPagesFetched: 206, pagesRequested: 500 };
  const saved = await store.save(snapshot(coverage));
  for (const [field, value] of Object.entries(coverage)) assert.equal(saved[field], value, field);
  assert.deepEqual((await store.list())[0], saved);
});

test("unsafe legacy pagination and an explicit completed cursor never become resumable", async t => {
  const { store } = await fixture(t);
  const capped = snapshot({ pagesFetched: 50, pagesRequested: 50, totalResults: 1652,
    effectiveUrl: buildAppleSearchUrl("https://jobs.apple.com/en-us/search"),
    stoppedEarly: "Page limit reached (50); more Apple search results may be available." });
  for (const overrides of [
    { pagesFetched: 49 },
    { errors: [{ phase: "search", page: 20, error: "Temporary failure" }] },
    { continuation: null },
    { stoppedEarly: "Apple repeated a results page; pagination was stopped." },
  ]) {
    const saved = await store.save({ ...capped, ...overrides });
    assert.equal(saved.continuation, null, JSON.stringify(overrides));
    assert.equal((await store.load(saved.id)).continuation, null);
  }
});
