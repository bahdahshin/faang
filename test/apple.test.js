import test from "node:test";
import assert from "node:assert/strict";
import { buildAppleSearchUrl, continuationFor, isSoftwareEngineeringRole, normalizeAppleJob, parseAppleSearch, scrapeApple } from "../lib/apple.js";

const source = "https://jobs.apple.com/en-us/search";
const role = (id, postingTitle = "Software Engineer", location = "Cupertino") => ({
  id, positionId: id.split("-")[0], postingTitle, team: { teamName: "Software and Services", teamCode: "SFTWR" },
  locations: [{ name: location, countryName: "United States" }],
  postDateInGMT: "2026-10-08T16:00:00.000Z", transformedPostingTitle: "software-engineer",
});
const page = (roles, number, totalRecords) => `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify({ loaderData: { search: { searchResults: roles, page: number, totalRecords } } }))});</script>`;
const response = text => new Response(text, { status: 200 });

test("accepts software engineering titles and rejects unrelated engineering and management", () => {
  for (const title of ["Software Engineer", "Senior Backend Engineer, Apple News", "UI Frameworks Engineer, Swift Platform Experience", "SDET(Fitness) - Watch Software", "Site Reliability Engineer", "Machine Learning Engineer", "Software Engineering Intern", "Software Engineer Internship", "Software Developer", "Platform Engineer"]) {
    assert.equal(isSoftwareEngineeringRole(role("200688024", title)), true, title);
  }
  for (const title of ["Mechanical Engineer", "CPU Verification ML Tool Engineer", "Senior Network Engineer", "Applied Data Scientist", "Engineering Project Manager", "Software Engineer Manager", "Software Engineering Program Manager", "Language Expert - Japanese", "Product Designer", "Apple Pay Technical Specialist", "Solutions Architect", "Senior Systems Engineer", "Research Scientist - Machine Learning"]) {
    assert.equal(isSoftwareEngineeringRole(role("200688024", title)), false, title);
  }
  assert.equal(isSoftwareEngineeringRole({ title: "Quality Engineer", team: { teamName: "Hardware" } }), false);
  for (const title of ["Software Engineer, Silicon Systems", "Firmware Engineer", "Senior Backend Engineer"]) {
    assert.equal(isSoftwareEngineeringRole({ title, team: { teamName: "Hardware", teamCode: "HRDWR" } }), true, title);
  }
});

test("parses escaped SSR safely and handles API wrappers and empty results", () => {
  const original = role("200688024-0836", 'Software Engineer, "Developer Tools"');
  assert.deepEqual(parseAppleSearch(page([original], 1, 2)), { jobs: [original], page: 1, totalResults: 2 });
  assert.deepEqual(parseAppleSearch({ res: { searchResults: [], totalRecords: 0 } }), { jobs: [], page: null, totalResults: 0 });
  assert.throws(() => parseAppleSearch("<html>Access denied</html>"), /not found/);
  assert.throws(() => parseAppleSearch({ res: { searchResults: null } }), /unexpected/);
});

test("search URLs preserve explicit filters without injecting software teams", () => {
  const url = new URL(buildAppleSearchUrl(`${source}?location=united-states-USA&search=swift&page=99`, 2));
  assert.equal(url.searchParams.get("location"), "united-states-USA");
  assert.equal(url.searchParams.get("search"), "swift");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.has("team"), false);
  assert.equal(new URL(buildAppleSearchUrl(source)).searchParams.has("team"), false);
  assert.ok(!url.href.includes("%2B"), "Apple team separators must be literal + after encoding");
  const copied = new URL(buildAppleSearchUrl(`${source}?team=apps-and-frameworks-SFTWR-AF%2Bcloud-and-back-end-infrastructure-SFTWR-CLD`, 1));
  assert.equal(copied.searchParams.get("team").split(" ").length, 2);
  assert.throws(() => buildAppleSearchUrl("https://example.com/search"), /Apple|jobs.apple.com/);
  assert.throws(() => buildAppleSearchUrl("https://jobs.apple.com:8443/en-us/search"), /jobs.apple.com/);
});

test("normalizes observed data, qualifications and US salary without guessing level", () => {
  const details = { positionId: "200688024", postingTitle: "Senior Backend Engineer, Apple News",
    minimumQualifications: "5-10 years of demonstrated experience shipping backend systems.",
    description: "Build distributed services.", locations: [{ name: "Cupertino", stateProvince: "California", countryName: "United States" }],
    postingFooters: [{ localizations: { en_US: [{ content: "The base pay range for this role is between $184,700 and $324,800.<br>Apple benefits." }] } }] };
  const job = normalizeAppleJob(role("200688024-0836"), source, details);
  assert.equal(job.id, "200688024"); assert.equal(job.yearsExperience, 5);
  assert.equal(job.salaryMin, 184700); assert.equal(job.salaryMax, 324800); assert.equal(job.salaryCurrency, "USD");
  assert.equal(job.level, "Senior"); assert.equal(job.specialty, "Backend"); assert.equal(job.postedDate, "2026-10-08");
  assert.equal(job.sourceUrl, source); assert.match(job.url, /details\/200688024-0836\//);
  const unknown = normalizeAppleJob(role("200688025"), source);
  assert.equal(unknown.level, null); assert.equal(unknown.yearsExperience, null); assert.equal(unknown.salaryMin, null);
  assert.equal(normalizeAppleJob(role("200688024"), source, { ...details, locations: [{ name: "Toronto", countryName: "Canada" }] }).salaryCurrency, null);
  assert.equal(normalizeAppleJob(role("200688024"), source, { ...details, minimumQualifications: "5 years in Quality Engineering role." }).yearsExperience, 5);
  assert.equal(normalizeAppleJob(role("200688024"), source, { ...details, minimumQualifications: "A four-year degree in engineering." }).yearsExperience, null);
});

test("paginates, filters and combines locations for duplicate role numbers", async () => {
  const requests = [];
  const data = [page([role("200688024-0836"), role("200688025", "Product Manager")], 1, 4),
    page([role("200688024-3337", "Software Engineer", "Seattle"), role("200688026", "UI Frameworks Engineer")], 2, 4)];
  const result = await scrapeApple({ url: source, pages: 10, maxDetails: 0, delayMs: 0,
    fetchImpl: async url => { requests.push(url); return response(data[requests.length - 1]); } });
  assert.equal(requests.length, 2); assert.equal(result.pagesFetched, 2); assert.equal(result.jobs.length, 2);
  assert.equal(result.stoppedEarly, null); assert.equal(result.jobs[0].id, "200688024");
  assert.match(result.jobs[0].location, /Cupertino/); assert.match(result.jobs[0].location, /Seattle/);
});

test("an unfiltered source examines software roles outside software teams and reports page coverage", async () => {
  const requests = [];
  const hardwareRole = (id, title) => ({ ...role(id, title), team: { teamName: "Hardware", teamCode: "HRDWR" } });
  const data = [page([hardwareRole("200688024", "Software Engineer, Silicon Systems"), hardwareRole("200688025", "Mechanical Engineer")], 1, 4),
    page([hardwareRole("200688026", "Firmware Engineer"), role("200688027", "Software Engineering Program Manager")], 2, 4)];
  const result = await scrapeApple({ url: source, delayMs: 0, maxDetails: 0, fetchImpl: async url => {
    requests.push(url); return response(data[requests.length - 1]);
  } });
  assert.ok(requests.every(url => !new URL(url).searchParams.has("team")));
  assert.deepEqual(result.jobs.map(job => job.id), ["200688024", "200688026"]);
  assert.equal(result.pageSize, 2); assert.equal(result.totalPages, 2);
  assert.equal(result.pagesFetched, 2); assert.equal(result.resultPagesFetched, 2); assert.equal(result.listingCount, 4);
});

test("reports a page cap as partial instead of claiming complete coverage", async () => {
  const result = await scrapeApple({ url: source, pages: 1, maxDetails: 0, delayMs: 0,
    fetchImpl: async () => response(page([role("200688024")], 1, 100)) });
  assert.equal(result.pagesFetched, 1); assert.equal(result.totalResults, 100); assert.match(result.stoppedEarly, /Page limit/);
});

test("stops repeated pagination and blocks instead of attempting alternate endpoints", async () => {
  let count = 0;
  const repeated = await scrapeApple({ pages: 3, maxDetails: 0, delayMs: 0, fetchImpl: async () => {
    count++; return response(JSON.stringify({ res: { searchResults: [role("200688024")], totalRecords: 100 } }));
  } });
  assert.equal(count, 2); assert.match(repeated.stoppedEarly, /repeated/); assert.equal(repeated.pagesFetched, 1);
  count = 0;
  const denied = await scrapeApple({ pages: 10, delayMs: 0, fetchImpl: async () => { count++; return new Response("blocked", { status: 429 }); } });
  assert.equal(count, 1); assert.equal(denied.errors[0].status, 429); assert.equal(denied.pagesFetched, 0);
});

test("enriches details and does not lose jobs on a missing details response", async () => {
  const calls = [];
  const result = await scrapeApple({ pages: 1, maxDetails: 2, delayMs: 0, fetchImpl: async url => {
    calls.push(url);
    if (calls.length === 1) return response(page([{ ...role("200688024"), locations: [{ name: "Cupertino", countryName: "United States of America" }] }, role("200688025")], 1, 2));
    if (calls.length === 2) return response(JSON.stringify({ res: { ...role("200688024"), locations: [{ name: "Cupertino", stateProvince: "California", countryName: "United States" }], minimumQualifications: "3+ years of software development experience" } }));
    return new Response("missing", { status: 404 });
  } });
  assert.equal(result.jobs.length, 2); assert.equal(result.jobs[0].yearsExperience, 3);
  assert.equal(result.jobs[0].location, "Cupertino, California, United States");
  assert.equal(result.detailsFetched, 1); assert.equal(result.errors[0].phase, "details");
  assert.equal(new URL(calls[1]).hostname, "jobs.apple.com"); assert.match(calls[1], /api\/v1\/jobDetails\/200688024/);
});

test("aborted input rejects before requesting, and a finite budget stops slow requests", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scrapeApple({ signal: controller.signal, fetchImpl: () => assert.fail("Must not fetch") }), /abort/i);
  const result = await scrapeApple({ pages: 1, timeBudgetMs: 10, delayMs: 0, fetchImpl: async (_url, { signal }) => {
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return response("unused");
  } });
  assert.match(result.stoppedEarly, /time budget/); assert.equal(result.jobs.length, 0);
});

test("resumes a legacy page-50 cap, preserves enriched jobs, and completes on an empty page", async () => {
  const enriched = { ...normalizeAppleJob(role("200688024-0836"), source), description: "Existing detail text", salaryMin: 120000, detailsRead: true };
  const saved = { sourceUrl: source, effectiveUrl: buildAppleSearchUrl(source), jobs: [enriched], pagesFetched: 50,
    pagesRequested: 50, totalResults: 1652, stoppedEarly: "Page limit reached (50); more Apple search results may be available.",
    errors: [], detailsFetched: 1, detailsRequested: 1 };
  assert.equal(continuationFor(saved).nextPage, 51);
  const requests = [];
  const result = await scrapeApple({ url: source, resume: saved, delayMs: 0, maxDetails: 1, fetchImpl: async url => {
    requests.push(url);
    const number = Number(new URL(url).searchParams.get("page"));
    return response(page(number === 51 ? [role("200688024-3337", "Software Engineer", "Seattle"), role("200688025")] : [], number, 1652));
  } });
  assert.deepEqual(requests.map(url => Number(new URL(url).searchParams.get("page"))), [51, 52]);
  assert.equal(result.pagesFetched, 52); assert.equal(result.stoppedEarly, null); assert.equal(result.continuation, null);
  assert.equal(result.jobs.length, 2); assert.equal(result.jobs[0].salaryMin, 120000); assert.equal(result.jobs[0].description, "Existing detail text");
  assert.match(result.jobs[0].location, /Seattle/); assert.equal(result.detailsFetched, 1);
});

test("rejects unsafe legacy cursors and source query drift before sending requests", async () => {
  const saved = { sourceUrl: source, effectiveUrl: buildAppleSearchUrl(source), jobs: [], pagesFetched: 50, pagesRequested: 50,
    stoppedEarly: "Page limit reached (50); more Apple search results may be available.", errors: [] };
  for (const overrides of [
    { sourceUrl: "https://example.com/en-us/search" },
    { effectiveUrl: buildAppleSearchUrl(`${source}?search=swift`) },
    { effectiveUrl: null },
    { effectiveUrl: buildAppleSearchUrl(`${source}?team=apps-and-frameworks-SFTWR-AF`) },
    { pagesFetched: 49 }, { stoppedEarly: null },
    { errors: [{ phase: "search", page: 23, error: "Timeout" }] },
    { errors: [{ phase: "details", status: 403, error: "Denied" }] },
    { continuation: { phase: "search", nextPage: 49 } },
    { continuation: null },
  ]) assert.equal(continuationFor({ ...saved, ...overrides }), null, JSON.stringify(overrides));
  await assert.rejects(scrapeApple({ url: `${source}?location=united-states-USA`, resume: saved, fetchImpl: () => assert.fail("Must not fetch") }), /current Apple search URL/);
  assert.equal(continuationFor({ ...saved, errors: [{ phase: "details", status: 404, error: "Missing details" }] }).nextPage, 51);
  const explicitlyFilteredSource = `${source}?team=apps-and-frameworks-SFTWR-AF&location=united-states-USA`;
  assert.equal(continuationFor({ ...saved, sourceUrl: explicitlyFilteredSource, effectiveUrl: buildAppleSearchUrl(explicitlyFilteredSource) }).nextPage, 51);
});

test("legacy unknown row coverage excludes an empty sentinel from the result-page count", async () => {
  const saved = { sourceUrl: source, effectiveUrl: buildAppleSearchUrl(source), jobs: [normalizeAppleJob(role("200688024"), source)],
    pagesFetched: 1, pagesRequested: 1, totalResults: 5, stoppedEarly: "Page limit reached (1); more Apple search results may be available.", errors: [] };
  const data = [page([role("200688025"), role("200688026")], 2, 5), page([role("200688027")], 3, 5), page([], 4, 0)];
  let calls = 0;
  const result = await scrapeApple({ url: source, resume: saved, delayMs: 0, maxDetails: 0,
    fetchImpl: async () => response(data[calls++]) });
  assert.equal(result.pagesFetched, 4); assert.equal(result.resultPagesFetched, 3);
  assert.equal(result.pageSize, 2); assert.equal(result.totalPages, 3); assert.equal(result.totalResults, 5);
  assert.equal(result.continuation, null); assert.equal(result.listingCount, null);
});

test("legacy SSR summaries do not skip unread details; an anchored budget stop preserves the successful prefix", async () => {
  const jobs = Array.from({ length: 530 }, (_, index) => normalizeAppleJob({ ...role(String(200600000 + index)), jobSummary: "Summary supplied by search" }, source));
  const saved = { sourceUrl: source, effectiveUrl: buildAppleSearchUrl(source), jobs, pagesFetched: 50, pagesRequested: 50, totalResults: 1652,
    stoppedEarly: "Page limit reached (50); more Apple search results may be available.",
    errors: [{ phase: "details", roleId: "200600086", error: "Fetch time budget reached." }],
    detailsFetched: 86, detailsRequested: 100, enrichmentStoppedEarly: "Fetch time budget reached." };
  assert.equal(jobs.filter(job => job.description).length, 530);
  assert.equal(continuationFor(saved).detailsDone.length, 86);
  assert.deepEqual(continuationFor({ ...saved, errors: [] }).detailsDone, []);
  assert.deepEqual(continuationFor({ ...saved, detailsFetched: 85 }).detailsDone, []);
  assert.equal(continuationFor({ ...saved, errors: [{ phase: "details", status: 429, error: "Rate limited" }] }), null);
  const detailRequests = [];
  const result = await scrapeApple({ url: source, resume: saved, delayMs: 0, fetchImpl: async url => {
    if (!url.includes("jobDetails")) return response(page([], 51, 1652));
    const id = new URL(url).pathname.split("/").at(-1); detailRequests.push(id);
    return response(JSON.stringify({ res: { ...role(id), description: "Actual role details" } }));
  } });
  assert.equal(detailRequests.length, 14); assert.equal(detailRequests[0], "200600086"); assert.equal(detailRequests.at(-1), "200600099");
  assert.equal(result.detailsFetched, 100); assert.equal(result.detailsCompleted, 100); assert.equal(result.continuation, null);
  assert.equal(result.jobs[86].detailsRead, true); assert.equal(result.jobs[100].detailsRead, undefined);
  const unanchored = await scrapeApple({ url: source, resume: { ...saved, errors: [] }, delayMs: 0, maxDetails: 100, fetchImpl: async url => {
    if (!url.includes("jobDetails")) return response(page([], 51, 1652));
    const id = new URL(url).pathname.split("/").at(-1);
    return response(JSON.stringify({ res: { ...role(id), description: "Re-read detail" } }));
  } });
  assert.equal(unanchored.detailsFetched, 100); assert.equal(unanchored.detailsCompleted, 100);
});

test("search errors resume the failed page and clear earlier transient errors", async () => {
  const requests = [];
  const first = await scrapeApple({ url: source, pages: 5, delayMs: 0, maxDetails: 0, fetchImpl: async url => {
    const number = Number(new URL(url).searchParams.get("page")); requests.push(number);
    return number === 1 ? response(page([role("200688024")], 1, 3)) : new Response("unavailable", { status: 503 });
  } });
  assert.deepEqual(requests, [1, 2]); assert.equal(first.continuation.nextPage, 2); assert.equal(first.pagesFetched, 1);
  const resumed = await scrapeApple({ url: source, resume: first, pages: 5, delayMs: 0, maxDetails: 0, fetchImpl: async url => {
    const number = Number(new URL(url).searchParams.get("page")); requests.push(number);
    return response(page([role("200688025"), role("200688026")], number, 3));
  } });
  assert.deepEqual(requests, [1, 2, 2]); assert.equal(resumed.jobs.length, 3);
  assert.equal(resumed.pagesFetched, 2); assert.equal(resumed.stoppedEarly, null); assert.deepEqual(resumed.errors, []); assert.equal(resumed.continuation, null);
});

test("a search budget saves its next page before any detail requests and completes on resume", async () => {
  let count = 0;
  const first = await scrapeApple({ url: source, delayMs: 0, timeBudgetMs: 20, maxDetails: 1, fetchImpl: async (_url, { signal }) => {
    count++;
    if (count === 1) return response(page([role("200688024")], 1, 2));
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  assert.equal(first.continuation.phase, "search"); assert.equal(first.continuation.nextPage, 2);
  assert.equal(first.detailsFetched, 0); assert.match(first.stoppedEarly, /time budget/);
  const requests = [];
  const resumed = await scrapeApple({ url: source, resume: first, delayMs: 0, maxDetails: 1, fetchImpl: async url => {
    requests.push(url);
    return response(url.includes("jobDetails") ? JSON.stringify({ res: { ...role("200688024"), description: "Build services" } }) : page([role("200688025")], 2, 2));
  } });
  assert.equal(requests.length, 2); assert.equal(resumed.jobs.length, 2); assert.equal(resumed.detailsFetched, 1);
  assert.equal(resumed.stoppedEarly, null); assert.equal(resumed.continuation, null);
});

test("detail-only continuation skips completed roles and leaves listing coverage complete", async () => {
  const requests = [];
  const first = await scrapeApple({ url: source, delayMs: 0, maxDetails: 2, timeBudgetMs: 25, fetchImpl: async (url, { signal }) => {
    requests.push(url);
    if (requests.length === 1) return response(page([role("200688024"), role("200688025")], 1, 2));
    if (requests.length === 2) return response(JSON.stringify({ res: { ...role("200688024"), description: "First description" } }));
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  assert.equal(first.stoppedEarly, null); assert.equal(first.continuation.phase, "details");
  assert.deepEqual(first.continuation.detailsDone, ["200688024"]); assert.equal(first.detailsRemaining, 1);
  const secondRequests = [];
  const resumed = await scrapeApple({ url: source, resume: first, delayMs: 0, maxDetails: 2, fetchImpl: async url => {
    secondRequests.push(url);
    return response(JSON.stringify({ res: { ...role("200688025"), description: "Second description" } }));
  } });
  assert.equal(secondRequests.length, 1); assert.match(secondRequests[0], /jobDetails\/200688025/);
  assert.equal(resumed.detailsFetched, 2); assert.equal(resumed.detailsCompleted, 2); assert.equal(resumed.detailsRemaining, 0);
  assert.equal(resumed.jobs[0].description, "First description"); assert.equal(resumed.jobs[1].description, "Second description");
  assert.equal(resumed.continuation, null); assert.equal(resumed.stoppedEarly, null); assert.deepEqual(resumed.errors, []);
});

test("raw row count includes duplicate location records so total coverage terminates correctly", async () => {
  let requests = 0;
  const result = await scrapeApple({ url: source, delayMs: 0, maxDetails: 0, fetchImpl: async () => {
    requests++; return response(page([role("200688024-0836"), role("200688024-3337", "Software Engineer", "Seattle")], 1, 2));
  } });
  assert.equal(requests, 1); assert.equal(result.jobs.length, 1); assert.equal(result.listingCount, 2); assert.equal(result.stoppedEarly, null);
});

test("an empty completion page reporting zero preserves the advertised total", async () => {
  const saved = { sourceUrl: source, effectiveUrl: buildAppleSearchUrl(source), jobs: [normalizeAppleJob(role("200688024"), source)], pagesFetched: 50, pagesRequested: 50,
    totalResults: 1652, stoppedEarly: "Page limit reached (50); more Apple search results may be available.", errors: [] };
  const result = await scrapeApple({ url: source, resume: saved, maxDetails: 0, delayMs: 0,
    fetchImpl: async () => response(page([], 51, 0)) });
  assert.equal(result.totalResults, 1652); assert.equal(result.pagesFetched, 51);
  assert.equal(result.stoppedEarly, null); assert.equal(result.continuation, null);
  const empty = await scrapeApple({ url: source, maxDetails: 0, delayMs: 0,
    fetchImpl: async () => response(page([], 1, 0)) });
  assert.equal(empty.totalResults, 0); assert.equal(empty.jobs.length, 0);
  const counted = await scrapeApple({ url: source, maxDetails: 0, delayMs: 0,
    resume: { ...saved, pagesFetched: 1, pagesRequested: 1, totalResults: 2, pageSize: 2,
      stoppedEarly: "Page limit reached (1); more Apple search results may be available.",
      continuation: { phase: "search", nextPage: 2, listingsSeen: 2, detailsDone: [] } },
    fetchImpl: async () => response(page([], 2, 0)) });
  assert.equal(counted.totalResults, 2); assert.equal(counted.stoppedEarly, null); assert.equal(counted.continuation, null);
});

test("persistent empty-zero pages exhaust bounded same-page retries and retain a resumable cursor", async () => {
  const requests = [];
  const first = await scrapeApple({ url: source, maxDetails: 0, delayMs: 0, fetchImpl: async url => {
    const number = Number(new URL(url).searchParams.get("page")); requests.push(number);
    return response(number === 1 ? page([role("200688024"), role("200688025")], 1, 4) : page([], 2, 0));
  } });
  assert.deepEqual(requests, [1, 2, 2, 2]); assert.equal(first.pagesFetched, 1); assert.equal(first.resultPagesFetched, 1);
  assert.equal(first.listingCount, 2); assert.equal(first.totalResults, 4);
  assert.equal(first.errors[0].code, "APPLE_INCOMPLETE_EMPTY_PAGE");
  assert.equal(first.continuation.phase, "search"); assert.equal(first.continuation.nextPage, 2);
  assert.equal(first.continuation.listingsSeen, 2); assert.equal(first.continuation.previousPageIds, "200688024|200688025");
  const resumed = await scrapeApple({ url: source, resume: first, maxDetails: 0, delayMs: 0, fetchImpl: async url => {
    const number = Number(new URL(url).searchParams.get("page")); requests.push(number);
    return response(page([role("200688026"), role("200688027")], number, 4));
  } });
  assert.deepEqual(requests, [1, 2, 2, 2, 2]); assert.equal(resumed.pagesFetched, 2); assert.equal(resumed.resultPagesFetched, 2);
  assert.equal(resumed.listingCount, 4); assert.equal(resumed.jobs.length, 4); assert.equal(resumed.totalResults, 4);
  assert.equal(resumed.stoppedEarly, null); assert.equal(resumed.continuation, null); assert.deepEqual(resumed.errors, []);
});

test("a premature empty response recovers through a paced same-page retry within one fetch", async () => {
  const requests = [], progress = [], requestTimes = [];
  const result = await scrapeApple({ url: source, maxDetails: 0, delayMs: 0, onProgress: message => progress.push(message), fetchImpl: async url => {
    const number = Number(new URL(url).searchParams.get("page")); requests.push(number); requestTimes.push(Date.now());
    if (number === 1) return response(page([role("200688024"), role("200688025")], 1, 4));
    return response(requests.length === 2 ? page([], 2, 0) : page([role("200688026"), role("200688027")], 2, 4));
  } });
  assert.deepEqual(requests, [1, 2, 2]); assert.ok(requestTimes[2] - requestTimes[1] >= 1000);
  assert.ok(progress.some(message => /Retrying Apple page 2 after an empty response/.test(message)));
  assert.equal(result.pagesFetched, 2); assert.equal(result.resultPagesFetched, 2); assert.equal(result.listingCount, 4);
  assert.equal(result.jobs.length, 4); assert.equal(result.continuation, null); assert.deepEqual(result.errors, []);
});

test("empty-response retry pacing respects the budget and cancellation", async () => {
  const requests = [];
  const budget = await scrapeApple({ url: source, maxDetails: 0, delayMs: 0, timeBudgetMs: 100, fetchImpl: async url => {
    const number = Number(new URL(url).searchParams.get("page")); requests.push(number);
    return response(number === 1 ? page([role("200688024")], 1, 2) : page([], 2, 0));
  } });
  assert.deepEqual(requests, [1, 2]); assert.match(budget.stoppedEarly, /time budget/);
  assert.equal(budget.pagesFetched, 1); assert.equal(budget.listingCount, 1); assert.equal(budget.continuation.nextPage, 2);
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(scrapeApple({ url: source, maxDetails: 0, delayMs: 0, signal: controller.signal,
    onProgress: message => { if (/Retrying Apple page/.test(message)) setTimeout(() => controller.abort(), 10); },
    fetchImpl: async url => {
      calls++; const number = Number(new URL(url).searchParams.get("page"));
      return response(number === 1 ? page([role("200688024")], 1, 2) : page([], 2, 0));
    } }), /abort/i);
  assert.equal(calls, 2);
});

test("HTTP 403 and repeated pagination never offer automatic continuation", async () => {
  const denied = await scrapeApple({ url: source, delayMs: 0, fetchImpl: async () => new Response("denied", { status: 403 }) });
  assert.equal(denied.continuation, null); assert.equal(continuationFor(denied), null);
  let count = 0;
  const repeated = await scrapeApple({ url: source, delayMs: 0, fetchImpl: async () => {
    count++; return response(JSON.stringify({ searchResults: [role("200688024")], totalRecords: 100 }));
  } });
  assert.equal(count, 2); assert.equal(repeated.continuation, null); assert.equal(continuationFor(repeated), null);
});

test("changed search formats and mismatched details are reported without retry loops", async () => {
  const changed = await scrapeApple({ url: source, delayMs: 0, fetchImpl: async () => response("<html>No search data</html>") });
  assert.match(changed.stoppedEarly, /search data was not found/); assert.equal(changed.continuation, null);
  let count = 0;
  const details = await scrapeApple({ url: source, delayMs: 0, maxDetails: 1, fetchImpl: async () => {
    count++;
    return response(count === 1 ? page([role("200688024")], 1, 1) : JSON.stringify({ res: role("200688099") }));
  } });
  assert.equal(details.jobs.length, 1); assert.match(details.errors[0].error, /different role/); assert.equal(details.continuation, null);
});

test("HTTP 429 preserves Retry-After and cannot resume before its deadline", async () => {
  const limited = await scrapeApple({ url: source, delayMs: 0, fetchImpl: async () => new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }) });
  assert.equal(limited.continuation.phase, "search"); assert.equal(limited.continuation.nextPage, 1);
  assert.ok(Date.parse(limited.continuation.retryAt) > Date.now() + 50000);
  await assert.rejects(scrapeApple({ url: source, resume: limited, fetchImpl: () => assert.fail("Must not fetch") }), error => error.status === 429 && /Resume after/.test(error.message));
});
