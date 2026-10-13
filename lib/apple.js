const APPLE_ORIGIN = "https://jobs.apple.com";

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\\n/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, " ").trim();
}

/** Positive engineering titles, not matches caused by keywords in a description. */
export function isSoftwareEngineeringRole(role) {
  const title = cleanText(role.postingTitle ?? role.title);
  const team = [role.team?.teamName, role.team?.teamCode, ...(Array.isArray(role.teamNames) ? role.teamNames : [])].filter(Boolean).join(" ");
  if (!title || /\b(?:manager|management|director|program|project|analyst|scientist|researcher|recruiter|specialist|technician|designer|sales|support)\b/i.test(title)) return false;
  if (/\b(?:software|firmware)\b/i.test(title) && /\b(?:engineer|engineering|developer|development)\b/i.test(title)) return true;
  if (/\bSDET\b/i.test(title)) return true;
  if (/\b(?:hardware|mechanical|electrical|silicon|asic|rtl|CPU|FPGA|SoC|chip|verification|physical design|circuit|battery|acoustic|manufacturing|network engineer|networking engineer)\b/i.test(title)) return false;
  if (/\b(?:back[- ]?end|front[- ]?end|full[- ]?stack|mobile|iOS|android|web|devops|site reliability|machine learning|ML|AI|applied AI|data|UI frameworks?|frameworks?|compiler|kernel)\b/i.test(title) && /\b(?:engineer|developer)\b/i.test(title)) return true;
  const softwareTeam = /software|SFTWR|machine learning|MLAI/i.test(team);
  return softwareTeam && /\b(?:platform|cloud|infrastructure|automation|quality|test|security|application|applications|graphics|developer tools|UI|user interface)\b/i.test(title) && /\b(?:engineer|developer)\b/i.test(title);
}

function unwrap(payload) {
  return payload?.res ?? payload?.data ?? payload;
}

/** Parse Apple's current React Router SSR payload without evaluating remote JavaScript. */
export function parseAppleSearch(content) {
  let data;
  if (typeof content === "object" && content !== null) data = unwrap(content);
  else {
    const text = String(content);
    if (/^\s*\{/.test(text)) data = unwrap(JSON.parse(text));
    else {
      const match = text.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*("(?:\\.|[^"\\])*")\s*\)/);
      if (match) data = JSON.parse(JSON.parse(match[1]))?.loaderData?.search;
      if (!data) throw new Error("Apple search data was not found. The careers page format may have changed.");
    }
  }
  if (!data || !Array.isArray(data.searchResults)) throw new Error("Apple returned an unexpected search response.");
  return {
    jobs: data.searchResults,
    totalResults: Number.isFinite(data.totalRecords) && data.totalRecords >= 0 ? data.totalRecords : null,
    page: Number.isInteger(data.page) ? data.page : null,
  };
}

export function buildAppleSearchUrl(sourceUrl, page = 1) {
  const url = new URL(sourceUrl || `${APPLE_ORIGIN}/en-us/search`);
  if (url.protocol !== "https:" || url.hostname !== "jobs.apple.com" || url.port || url.username || url.password || url.pathname !== "/en-us/search") {
    throw new Error("Use an https://jobs.apple.com/en-us/search URL.");
  }
  url.hash = "";
  // Preserve explicit source filters. Apple uses decoded spaces between teams.
  if (url.searchParams.get("team")) url.searchParams.set("team", url.searchParams.get("team").replaceAll("+", " "));
  url.searchParams.set("sort", "newest");
  url.searchParams.set("page", String(page));
  return url.href;
}

function roleNumber(role) {
  const raw = String(role.positionId ?? role.jobNumber ?? role.id ?? role.reqId ?? "");
  return raw.match(/^(?:REQ-|PIPE-)?(\d{6,12})(?:-\d+)?$/)?.[1] ?? null;
}

function detailId(role) {
  const raw = String(role.jobNumber ?? role.id ?? role.reqId ?? role.positionId ?? "");
  return raw.match(/^(?:REQ-)?(\d{6,12}(?:-\d+)?)$/)?.[1] ?? roleNumber(role);
}

function getLevel(title) {
  if (/\b(?:intern|internship)\b/i.test(title)) return "Intern";
  if (/\b(?:principal|distinguished)\b/i.test(title)) return "Principal";
  if (/\bstaff\b/i.test(title)) return "Staff";
  if (/\b(?:senior|sr\.?)\b/i.test(title)) return "Senior";
  if (/\b(?:junior|jr\.?|entry[- ]level|new grad|early career)\b/i.test(title)) return "Junior";
  // Apple titles often omit level. Do not invent "Mid" for those roles.
  return null;
}

function getSpecialty(title) {
  if (/machine learning|\bML\b|\bAI\b/i.test(title)) return "AI / ML";
  if (/back[- ]?end/i.test(title)) return "Backend";
  if (/front[- ]?end|\bUI\b|user interface|web/i.test(title)) return "Frontend";
  if (/full[- ]?stack/i.test(title)) return "Full Stack";
  if (/\biOS\b|android|mobile|watch software/i.test(title)) return "Mobile";
  if (/site reliability|devops/i.test(title)) return "SRE / DevOps";
  if (/data engineer|data platform/i.test(title)) return "Data";
  if (/security/i.test(title)) return "Security";
  if (/quality|SDET|automation|test/i.test(title)) return "Quality / Test";
  if (/firmware|embedded|kernel|operating system/i.test(title)) return "Systems";
  if (/platform|cloud|infrastructure|compiler|framework/i.test(title)) return "Platform";
  return null;
}

function getYears(text) {
  const patterns = [
    /(?:at least|minimum(?: of)?|more than)?\s*(\d{1,2})\s*(?:[-–]\s*\d{1,2})?\s*\+?\s*years?\s+(?:of\s+)?(?:professional\s+|relevant\s+|demonstrated\s+|hands[- ]on\s+|industry\s+|work\s+|software\s+|development\s+)*experience/ig,
    /(\d{1,2})\s*\+?\s*years?\s+(?:of\s+)?(?:software|backend|front[- ]end|programming|engineering|development)\b/ig,
    /(\d{1,2})\s*(?:[-–]\s*\d{1,2})?\s*\+?\s*years?\s+(?:in|as)\s+(?:an?\s+)?(?:[a-z/-]+\s+){0,8}(?:engineering|engineer|development|developer|SDET)\b(?:\s+[a-z/-]+){0,5}\s+role\b/ig,
  ];
  const years = patterns.flatMap(pattern => [...text.matchAll(pattern)].map(m => Number(m[1]))).filter(n => n <= 40);
  return years.length ? Math.min(...years) : null;
}

function salaryFromText(text, locations) {
  const unknown = { salaryMin: null, salaryMax: null, salaryCurrency: null };
  // A bare "$" is not a reliable USD indicator on Apple's worldwide listings.
  if (!locations.some(location => /^(?:United States(?: of America)?|USA)$/i.test(location.countryName || "")) && !/\bUSD\b|US\s*\$/i.test(text)) return unknown;
  // Restrict extraction to a stated base-pay/salary range, not benefits or stock amounts.
  const range = text.match(/(?:base pay|base salary|salary)(?:[^$]{0,180})(?:between\s*)?\$([\d,]+(?:\.\d+)?)\s*(?:and|to|[-–])\s*\$([\d,]+(?:\.\d+)?)/i);
  if (!range || /(?:per hour|hourly|an hour)\b/i.test(text.slice(range.index, range.index + range[0].length + 50))) return unknown;
  const min = Number(range[1].replaceAll(",", "")), max = Number(range[2].replaceAll(",", ""));
  if (min < 10000 || max < min || max > 2000000) return unknown;
  return { salaryMin: min, salaryMax: max, salaryCurrency: "USD" };
}

function footerText(role) {
  return (role.postingFooters || []).flatMap(footer => Object.values(footer.localizations || {}).flat()).map(footer => cleanText(footer.content)).join(" ");
}

function mergeLocations(...values) {
  const locations = new Map();
  for (const location of values.flatMap(value => value?.split(" · ") || [])) {
    const normalized = location.replace(/United States of America/gi, "United States");
    const parts = normalized.split(", ");
    const key = `${parts[0].toLowerCase()}|${parts.at(-1).toLowerCase()}`;
    const previous = locations.get(key);
    if (!previous || parts.length > previous.split(", ").length) locations.set(key, normalized);
  }
  return [...locations.values()].join(" · ") || null;
}

export function normalizeAppleJob(role, sourceUrl, details) {
  const full = details ? { ...role, ...details } : role;
  const title = cleanText(full.postingTitle ?? full.title);
  const qualifications = cleanText(full.minimumQualifications ?? "");
  const description = [full.jobSummary, full.description, full.responsibilities, full.minimumQualifications, full.preferredQualifications].map(cleanText).filter(Boolean).join("\n\n");
  const locations = (full.locations || []).map(location => {
    const country = location.countryName;
    const parts = [location.name || location.city, location.stateProvince, country];
    return [...new Set(parts.filter(Boolean))].join(", ");
  }).filter(Boolean);
  const slug = String(full.transformedPostingTitle || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const date = full.postingDateMeta ?? full.postDateInGMT ?? full.longPostingDate ?? full.postingDate;
  const timestamp = date ? new Date(date) : null;
  const id = roleNumber(full) ?? roleNumber(role);
  return {
    id, title, company: "Apple", source: "Apple", sourceUrl,
    location: locations.length ? mergeLocations(locations.join(" · ")) : full.homeOffice ? "Remote" : null,
    level: getLevel(title), specialty: getSpecialty(title),
    yearsExperience: qualifications ? getYears(qualifications) : null,
    ...salaryFromText(footerText(full), full.locations || []),
    postedDate: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString().slice(0, 10) : null,
    url: `${APPLE_ORIGIN}/en-us/details/${encodeURIComponent(detailId(role) || id)}/${encodeURIComponent(slug)}`,
    description: description || null,
  };
}

function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function delay(ms, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function queryKey(url) {
  const query = new URL(buildAppleSearchUrl(url));
  query.searchParams.delete("page");
  query.searchParams.sort();
  return query.href;
}

const isUnsafePagination = error => /repeated a results page|when page \d+ was requested/i.test(error.error ?? error.message ?? "");
const isTransient = error => !isUnsafePagination(error) && (error.code === "APPLE_INCOMPLETE_EMPTY_PAGE" || error.status === 429 || error.status >= 500 ||
  (!error.status && /time budget|timed out|\btimeout\b|fetch failed|failed to fetch|network|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED/i.test(`${error.error ?? error.message ?? ""} ${error.code ?? error.cause?.code ?? ""}`)));

/** A persisted cursor is usable only for the same validated Apple search. */
export function continuationFor(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.jobs) || !Number.isInteger(snapshot.pagesFetched) || snapshot.pagesFetched < 0 || snapshot.pagesFetched > 500) return null;
  if (snapshot.jobs.some(job => !job || typeof job !== "object")) return null;
  try {
    if (!snapshot.sourceUrl || !snapshot.effectiveUrl || queryKey(snapshot.sourceUrl) !== queryKey(snapshot.effectiveUrl)) return null;
    queryKey(snapshot.sourceUrl);
  } catch { return null; }
  const errors = snapshot.errors ?? [];
  if (!Array.isArray(errors) || errors.some(error => !error || typeof error !== "object" || error.status === 403 || isUnsafePagination(error))) return null;
  const state = snapshot.resumeState;
  if (state != null && (typeof state !== "object" || (state.detailRoles != null && (!Array.isArray(state.detailRoles) || state.detailRoles.some(entry => !entry?.role || roleNumber(entry.role) !== entry.id))))) return null;
  let cursor = snapshot.continuation;
  if (Object.hasOwn(snapshot, "continuation")) {
    if (!cursor || !["search", "details"].includes(cursor.phase)) return null;
    if (!Number.isInteger(cursor.nextPage) || cursor.nextPage !== snapshot.pagesFetched + 1 || cursor.nextPage > 501) return null;
    if (cursor.phase === "details" && snapshot.stoppedEarly) return null;
    if (cursor.previousPageIds != null && typeof cursor.previousPageIds !== "string") return null;
    if (cursor.listingsSeen != null && (!Number.isInteger(cursor.listingsSeen) || cursor.listingsSeen < 0)) return null;
    if (cursor.detailsDone != null && (!Array.isArray(cursor.detailsDone) || cursor.detailsDone.some(id => !/^\d{6,12}$/.test(id)))) return null;
    if (cursor.retryAt != null && (!Number.isFinite(Date.parse(cursor.retryAt)) || typeof cursor.retryAt !== "string")) return null;
    // A rate-limited snapshot must carry its wait deadline before it can resume.
    if (errors.some(error => error.status === 429) && !cursor.retryAt) return null;
  } else {
    // Older snapshots have no raw pagination state. Only their explicit page cap
    // proves the preceding pages were collected contiguously. Do not infer a
    // raw row count from filtered, deduplicated jobs.
    if (errors.some(error => error.phase !== "details" || error.status === 429)) return null;
    const limit = typeof snapshot.stoppedEarly === "string" && snapshot.stoppedEarly.match(/^Page limit reached \((\d+)\);/);
    if (limit && Number(limit[1]) === snapshot.pagesFetched && snapshot.pagesRequested === snapshot.pagesFetched && snapshot.pagesFetched > 0) {
      cursor = { phase: "search", nextPage: snapshot.pagesFetched + 1 };
    } else if (!snapshot.stoppedEarly && snapshot.pagesFetched > 0 && /time budget|timed out/i.test(snapshot.enrichmentStoppedEarly ?? "") && snapshot.detailsFetched < snapshot.detailsRequested) {
      cursor = { phase: "details", nextPage: snapshot.pagesFetched + 1 };
    } else return null;
  }
  // Search rows already contain jobSummary, so description is not evidence of
  // reading the detail endpoint. New jobs carry an explicit marker. For an old
  // interrupted run, its sole failed detail ID can prove a successful prefix
  // only when that ID's index exactly agrees with the successful detail count.
  const legacyDone = snapshot.jobs.filter(job => job.detailsRead === true && /^\d{6,12}$/.test(job.id)).map(job => job.id);
  if (errors.length === 1 && errors[0].phase === "details" && /time budget|timed out/i.test(errors[0].error ?? "") &&
      Number.isInteger(snapshot.detailsFetched) && snapshot.detailsFetched >= 0 && snapshot.detailsFetched < snapshot.detailsRequested) {
    const failedIndex = snapshot.jobs.findIndex(job => job.id === errors[0].roleId);
    if (failedIndex === snapshot.detailsFetched) legacyDone.push(...snapshot.jobs.slice(0, failedIndex).map(job => job.id).filter(id => /^\d{6,12}$/.test(id)));
  }
  const previousPageIds = cursor.previousPageIds ?? state?.previousPageIds ?? null;
  const listingsSeen = cursor.listingsSeen ?? state?.listingCount ?? snapshot.listingCount ?? null;
  if (previousPageIds !== null && typeof previousPageIds !== "string") return null;
  if (listingsSeen !== null && (!Number.isInteger(listingsSeen) || listingsSeen < 0)) return null;
  if (cursor.phase === "search" && cursor.nextPage > 500) return null;
  return { ...cursor, previousPageIds, listingsSeen, detailsDone: cursor.detailsDone ?? [...new Set(legacyDone)] };
}

function roleFromJob(job) {
  let jobNumber = job.id;
  try {
    const url = new URL(job.url);
    const candidate = url.pathname.match(/^\/en-us\/details\/(\d{6,12}(?:-\d+)?)\//)?.[1];
    if (url.origin === APPLE_ORIGIN && candidate?.split("-")[0] === job.id) jobNumber = candidate;
  } catch {}
  return { positionId: job.id, jobNumber, postingTitle: job.title, postDateInGMT: job.postedDate,
    team: { teamCode: "SFTWR" } };
}

function retryDeadline(response) {
  const value = response.headers?.get("retry-after");
  const parsed = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return new Date(Number.isFinite(parsed) ? Math.max(Date.now(), parsed) : Date.now() + 60000).toISOString();
}

/** A bounded, paced fetch that saves the next page or unfinished detail queue. */
export async function scrapeApple({ url = `${APPLE_ORIGIN}/en-us/search`, pages = 500, onProgress = () => {}, signal,
  fetchImpl = fetch, timeoutMs = 20000, timeBudgetMs = 240000, delayMs = 250, maxDetails = 100, resume = null } = {}) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 500) throw new Error("pages must be an integer between 1 and 500.");
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Fetch timeouts must be positive finite numbers.");
  if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isInteger(maxDetails) || maxDetails < 0 || maxDetails > 1000) throw new Error("Invalid pacing or detail limit.");
  // Validate before any request and keep the requested source query intact.
  const effectiveUrl = buildAppleSearchUrl(url);
  const cursor = resume ? continuationFor(resume) : null;
  if (resume && (!cursor || queryKey(resume.sourceUrl) !== queryKey(url))) throw new Error("This saved fetch cannot resume with the current Apple search URL. Start a new fetch.");
  if (resume?.resumeState?.maxDetails != null && resume.resumeState.maxDetails !== maxDetails) throw new Error("The detail limit changed. Start a new fetch.");
  if (cursor?.retryAt && Date.parse(cursor.retryAt) > Date.now()) {
    const error = new Error(`Apple rate-limited this fetch. Resume after ${cursor.retryAt}.`);
    error.status = 429; error.retryAt = cursor.retryAt; throw error;
  }
  const startedAt = Date.now(), deadline = startedAt + timeBudgetMs;
  const result = { fetchedAt: new Date(startedAt).toISOString(), sourceUrl: url, jobs: [],
    errors: (resume?.errors ?? []).filter(error => error.phase === "details" && !isTransient(error)),
    pagesFetched: resume?.pagesFetched ?? 0, pagesRequested: pages, totalResults: resume?.totalResults ?? null,
    stoppedEarly: null, effectiveUrl, listingCount: cursor ? cursor.listingsSeen : 0,
    pageSize: Number.isInteger(resume?.pageSize) && resume.pageSize > 0 ? resume.pageSize : null, totalPages: null,
    resultPagesFetched: resume ? Number.isInteger(resume.resultPagesFetched) && resume.resultPagesFetched >= 0 && resume.resultPagesFetched <= resume.pagesFetched
      ? resume.resultPagesFetched : cursor.phase === "search" ? resume.pagesFetched : null : 0,
    detailsFetched: 0, detailsRequested: 0, detailsCompleted: 0, detailsRemaining: 0,
    enrichmentStoppedEarly: null, continuation: null, resumeState: null };
  const jobs = new Map((resume?.jobs ?? []).filter(job => /^\d{6,12}$/.test(job.id)).map(job => [job.id, { ...job }]));
  const rawRoles = new Map();
  for (const entry of resume?.resumeState?.detailRoles ?? []) {
    if (entry && roleNumber(entry.role) === entry.id && rawRoles.size < maxDetails) rawRoles.set(entry.id, entry.role);
  }
  // A legacy fetch already enriched some of these jobs. Reconstruct only the
  // minimal Apple role metadata needed for its newest detail candidates.
  if (resume && !resume.resumeState?.detailRoles) {
    for (const job of jobs.values()) { if (rawRoles.size >= maxDetails) break; rawRoles.set(job.id, roleFromJob(job)); }
  }
  const detailsDone = new Set((cursor?.detailsDone ?? []).filter(id => rawRoles.has(id)));
  // Count only successful work proven to belong to the resumed queue. An old
  // unanchored count cannot be added to re-read details without double-counting.
  if (resume) result.detailsFetched = Math.min(Number.isInteger(resume.detailsFetched) ? Math.max(0, resume.detailsFetched) : detailsDone.size, detailsDone.size);
  let previousPageIds = cursor?.previousPageIds ?? null, listingComplete = cursor?.phase === "details", lastRequestAt = 0;
  let nextPage = cursor?.nextPage ?? 1;
  const saveCursor = (phase, error) => ({ phase, nextPage, previousPageIds, listingsSeen: result.listingCount,
    detailsDone: [...detailsDone], ...(error?.retryAt && { retryAt: error.retryAt }) });
  async function request(requestUrl) {
    aborted(signal);
    const waitMs = Math.max(0, delayMs - (Date.now() - lastRequestAt));
    if (Date.now() + waitMs >= deadline) throw new Error("Fetch time budget reached.");
    if (waitMs) await delay(waitMs, signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Fetch time budget reached.");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(Date.now() >= deadline ? "Fetch time budget reached." : "Apple request timed out.")), Math.min(timeoutMs, remaining));
    try {
      lastRequestAt = Date.now();
      const response = await fetchImpl(requestUrl, { headers: { "User-Agent": "SoftwareJobsDashboard/1.0", Accept: "text/html,application/json", locale: "en-us" }, signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        const error = new Error(`Apple returned HTTP ${response.status}${[403, 429].includes(response.status) ? "; fetching stopped." : "."}`);
        error.status = response.status;
        if (response.status === 429) error.retryAt = retryDeadline(response);
        throw error;
      }
      return await response.text();
    } catch (error) {
      aborted(signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  for (let page = nextPage; !listingComplete && page <= pages; page++) {
    aborted(signal);
    onProgress(`Fetching Apple page ${page} of up to ${pages}…`);
    try {
      let search;
      for (let emptyRetries = 0; ; emptyRetries++) {
        search = parseAppleSearch(await request(buildAppleSearchUrl(url, page)));
        if (search.page !== null && search.page !== page) throw new Error(`Apple returned page ${search.page} when page ${page} was requested.`);
        const prematureEmpty = !search.jobs.length && search.totalResults === 0 && result.listingCount !== null && result.totalResults !== null && result.listingCount < result.totalResults;
        if (!prematureEmpty) break;
        if (emptyRetries >= 2) {
          const error = new Error("Apple returned an empty results page before all advertised listings were read. Resume to retry this page.");
          error.code = "APPLE_INCOMPLETE_EMPTY_PAGE";
          throw error;
        }
        onProgress(`Retrying Apple page ${page} after an empty response (${emptyRetries + 1} of 2)…`);
        if (Date.now() + 1000 >= deadline) throw new Error("Fetch time budget reached.");
        await delay(1000, signal);
      }
      const ids = search.jobs.map(role => String(role.id ?? role.reqId ?? role.positionId ?? "")).join("|");
      if (search.jobs.length && ids === previousPageIds) throw new Error("Apple repeated a results page; pagination was stopped to avoid a misleading complete fetch.");
      previousPageIds = ids;
      result.pagesFetched++;
      if (search.jobs.length) {
        result.pageSize = Math.max(result.pageSize ?? 0, search.jobs.length);
        if (result.resultPagesFetched !== null) result.resultPagesFetched++;
      }
      nextPage = page + 1;
      if (result.listingCount !== null) result.listingCount += search.jobs.length;
      // Apple's page after the final results can advertise zero. Keep the last
      // nonzero search total when that empty page is only the completion marker.
      if (search.totalResults !== null && !(search.jobs.length === 0 && search.totalResults === 0 && result.totalResults > 0)) result.totalResults = search.totalResults;
      for (const role of search.jobs) {
        if (!isSoftwareEngineeringRole(role)) continue;
        const normalized = normalizeAppleJob(role, url);
        if (!normalized.id) continue;
        if (jobs.has(normalized.id)) {
          const existing = jobs.get(normalized.id);
          existing.location = mergeLocations(existing.location, normalized.location);
        } else jobs.set(normalized.id, normalized);
        if (!rawRoles.has(normalized.id) && rawRoles.size < maxDetails) rawRoles.set(normalized.id, role);
      }
      onProgress(`Page ${page}: ${jobs.size} software engineering roles collected.`);
      if (!search.jobs.length || (result.totalResults !== null && result.listingCount !== null && result.listingCount >= result.totalResults)) { listingComplete = true; break; }
    } catch (error) {
      aborted(signal);
      nextPage = page;
      result.errors.push({ phase: "search", page, error: error.message, ...(error.code && { code: error.code }), ...(error.status && { status: error.status }), ...(error.retryAt && { retryAt: error.retryAt }) });
      result.stoppedEarly = error.message;
      if (isTransient(error)) result.continuation = saveCursor("search", error);
      break;
    }
  }
  if (!listingComplete && !result.stoppedEarly) {
    result.stoppedEarly = `Page limit reached (${pages}); more Apple search results may be available.`;
    result.continuation = saveCursor("search");
  }
  const detailRoles = [...rawRoles.entries()];
  result.detailsRequested = detailRoles.length;
  // Do not issue more requests after Apple denies or rate-limits a listing request.
  const blocked = result.errors.some(error => [403, 429].includes(error.status));
  if (blocked) result.enrichmentStoppedEarly = "Apple denied or rate-limited the request.";
  else if (!listingComplete) result.enrichmentStoppedEarly = "Waiting for remaining search pages before reading role details.";
  else for (const [id, role] of detailRoles) {
    aborted(signal);
    if (detailsDone.has(id)) continue;
    if (Date.now() >= deadline) {
      result.enrichmentStoppedEarly = "Fetch time budget reached.";
      result.continuation = saveCursor("details"); break;
    }
    onProgress(`Reading role details ${detailsDone.size + 1} of ${detailRoles.length}…`);
    try {
      const details = unwrap(JSON.parse(await request(`${APPLE_ORIGIN}/api/v1/jobDetails/${encodeURIComponent(detailId(role))}?locale=en-us`)));
      if (!details || typeof details.postingTitle !== "string") throw new Error("Apple returned unexpected job details.");
      // Require matching role numbers before trusting a remote detail response.
      if (roleNumber(details) !== id) throw new Error("Apple returned details for a different role.");
      const enriched = normalizeAppleJob(role, url, details);
      enriched.detailsRead = true;
      if (isSoftwareEngineeringRole(details)) {
        const existing = jobs.get(id);
        enriched.location = mergeLocations(existing?.location, enriched.location);
        jobs.set(id, enriched);
      } else jobs.delete(id);
      result.detailsFetched++;
      detailsDone.add(id);
    } catch (error) {
      aborted(signal);
      result.errors.push({ phase: "details", roleId: id, error: error.message, ...(error.status && { status: error.status }), ...(error.retryAt && { retryAt: error.retryAt }) });
      if (error.status === 403 || isTransient(error)) {
        result.enrichmentStoppedEarly = error.message;
        if (isTransient(error)) result.continuation = saveCursor("details", error);
        break;
      }
      detailsDone.add(id);
    }
  }
  if (!result.enrichmentStoppedEarly && maxDetails === 0 && jobs.size) result.enrichmentStoppedEarly = "Role detail enrichment was disabled.";
  else if (!result.enrichmentStoppedEarly && jobs.size > maxDetails) result.enrichmentStoppedEarly = `Details limited to the newest ${maxDetails} roles; remaining salary and experience fields may be unknown.`;
  result.detailsCompleted = detailsDone.size;
  result.detailsRemaining = detailRoles.length - detailsDone.size;
  result.resumeState = { detailRoles: detailRoles.map(([id, role]) => ({ id, role })), listingCount: result.listingCount,
    previousPageIds, maxDetails };
  result.totalPages = result.totalResults === 0 ? 0 : result.totalResults !== null && result.pageSize ? Math.ceil(result.totalResults / result.pageSize) : null;
  result.jobs = [...jobs.values()];
  onProgress(`Collected ${result.jobs.length} software engineering roles across ${result.pagesFetched} pages.`);
  return result;
}
