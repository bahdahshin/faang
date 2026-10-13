const idOf = role => String(role?.id ?? '');

export function continuationForEightfold(adapter, snapshot) {
  try {
    if (!snapshot || !snapshot.sourceUrl || !snapshot.effectiveUrl || !Array.isArray(snapshot.jobs) || snapshot.jobs.some(job => !job || typeof job !== 'object') || !Number.isInteger(snapshot.pagesFetched) || snapshot.pagesFetched < 0 || snapshot.pagesFetched > 500 || adapter.canonicalUrl(snapshot.sourceUrl) !== adapter.canonicalUrl(snapshot.effectiveUrl)) return null;
    const cursor = snapshot.continuation;
    if (!cursor || !['search','details'].includes(cursor.phase) || cursor.nextPage !== snapshot.pagesFetched + 1 || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset !== snapshot.listingCount) return null;
    if (cursor.phase === 'search' && cursor.nextPage > 500) return null;
    if (snapshot.errors?.some(error => error.status === 403 || /repeated a results page|unexpected search response/i.test(error.error))) return null;
    if (!Array.isArray(cursor.detailsDone) || cursor.detailsDone.some(id => !/^\d{1,20}$/.test(id))) return null;
    if (!Array.isArray(snapshot.resumeState?.detailRoles) || snapshot.resumeState.detailRoles.some(role => !/^\d{1,20}$/.test(idOf(role)))) return null;
    const queued = new Set(snapshot.resumeState.detailRoles.map(idOf));
    if (new Set(cursor.detailsDone).size !== cursor.detailsDone.length || cursor.detailsDone.some(id => !queued.has(id))) return null;
    if (cursor.retryAt && !Number.isFinite(Date.parse(cursor.retryAt))) return null;
    const pacing = snapshot.resumeState;
    if (pacing.requestDelayMs != null && (!Number.isFinite(pacing.requestDelayMs) || pacing.requestDelayMs < 0 || pacing.requestDelayMs > 60000)) return null;
    if (pacing.lastRequestAt != null && (!Number.isFinite(pacing.lastRequestAt) || pacing.lastRequestAt < 0)) return null;
    if (snapshot.errors?.some(error => error.status === 429) && !cursor.retryAt) return null;
    return cursor;
  } catch { return null; }
}
const abortCheck = signal => { if (signal?.aborted) throw signal.reason || new Error('Fetch cancelled.'); };
const pause = (ms, signal) => new Promise((resolve, reject) => {
  abortCheck(signal);
  const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Fetch cancelled.')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
const retryable = error => error.transient || Boolean(error.retryAt) || error.status === 429 || error.status >= 500 || (!error.status && /time budget|timed out|fetch failed|network|socket/i.test(error.message || error.error));
export async function scrapeEightfold(adapter, { url = adapter.sourceUrl, pages = 500, onProgress = () => {}, signal, fetchImpl = fetch,
  timeoutMs = 20000, timeBudgetMs = 240000, delayMs = adapter.delayMs ?? 1000, maxDetails = 1000, resume = null } = {}) {
  const effectiveUrl = adapter.canonicalUrl(url);
  if (!Number.isInteger(pages) || pages < 1 || pages > 500 || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000 || !Number.isInteger(maxDetails) || maxDetails < 0 || maxDetails > 1000) throw new Error(`Invalid ${adapter.label} fetch limits.`);
  const cursor = resume ? continuationForEightfold(adapter, resume) : null;
  if (resume && (!cursor || adapter.canonicalUrl(resume.sourceUrl) !== effectiveUrl || !Number.isInteger(resume.resumeState.maxDetails) || resume.resumeState.maxDetails > maxDetails)) throw new Error(`This ${adapter.label} checkpoint cannot resume with the current source. Start a new fetch.`);
  if (cursor?.retryAt && Date.parse(cursor.retryAt) > Date.now()) throw new Error(`${adapter.label} requested a cooldown until ${cursor.retryAt}.`);
  const deadline = Date.now() + timeBudgetMs;
  const jobs = new Map((resume?.jobs || []).map(job => [job.id, { ...job }]));
  const detailRoles = new Map((resume?.resumeState?.detailRoles || []).map(role => [idOf(role), role]));
  const done = new Set(cursor?.detailsDone || []);
  // Older checkpoints only queued the first 100 roles. Recover the remaining IDs
  // from the saved jobs so increasing detail coverage does not re-read search pages.
  for (const job of jobs.values()) {
    if (detailRoles.size < maxDetails && !detailRoles.has(job.id)) detailRoles.set(job.id, { id: job.id });
    if (job.detailsRead && detailRoles.has(job.id)) done.add(job.id);
  }
  let offset = cursor?.offset || 0, nextPage = cursor?.nextPage || 1, previousIds = resume?.resumeState?.previousIds || '';
  let requestDelayMs = Math.max(delayMs, resume?.resumeState?.requestDelayMs || 0);
  let lastRequest = Math.min(Date.now(), resume?.resumeState?.lastRequestAt || 0);
  let complete = cursor?.phase === 'details';
  const result = { fetchedAt: new Date().toISOString(), provider: adapter.provider, sourceUrl: url, effectiveUrl, jobs: [], errors: (resume?.errors || []).filter(error => error.phase === 'details' && !retryable(error)),
    pagesFetched: resume?.pagesFetched || 0, pagesRequested: pages, resultPagesFetched: resume?.resultPagesFetched || 0,
    totalResults: resume?.totalResults ?? null, pageSize: resume?.pageSize ?? null, totalPages: null, listingCount: offset,
    stoppedEarly: null, continuation: null, detailsFetched: resume?.detailsFetched || 0, detailsRequested: 0, detailsCompleted: 0, detailsRemaining: 0, enrichmentStoppedEarly: null };
  const saveCursor = (phase, error) => ({ phase, nextPage, offset, detailsDone: [...done], ...(error?.retryAt && { retryAt: error.retryAt }) });
  async function request(target) {
    abortCheck(signal);
    const spacing = Math.max(0, requestDelayMs - (Date.now() - lastRequest));
    if (Date.now() + spacing >= deadline) throw new Error('Fetch time budget reached.');
    if (spacing) await pause(spacing, signal);
    if (Date.now() >= deadline) throw new Error('Fetch time budget reached.');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(Date.now() >= deadline ? 'Fetch time budget reached.' : `${adapter.label} request timed out.`)), Math.min(timeoutMs, deadline - Date.now()));
    try {
      lastRequest = Date.now();
      const response = await fetchImpl(target, { headers: { Accept: 'application/json', 'User-Agent': 'SoftwareJobsDashboard/1.0' }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        const error = Object.assign(new Error(`${adapter.label} returned HTTP ${response.status}.`), { status: response.status });
        if (response.status === 429) {
          requestDelayMs = Math.min(60000, requestDelayMs * 2);
          const retry = response.headers?.get('retry-after');
          const wait = /^\d+$/.test(retry || '') ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
          error.retryAt = new Date(Number.isFinite(wait) ? Math.max(Date.now() + requestDelayMs, wait) : Date.now() + 60000).toISOString();
        }
        throw error;
      }
      const body = await response.text();
      // Some careers feeds return their temporary throttle notice with HTTP 200.
      // Preserve a cooldown checkpoint instead of treating it as job data.
      if (/^please try again later[.!]?$/i.test(body.trim())) {
        requestDelayMs = Math.min(60000, requestDelayMs * 2);
        throw Object.assign(new Error(`${adapter.label} asked to try again later.`), {
          transient: true, retryAt: new Date(Date.now() + 60000).toISOString(),
        });
      }
      try { return JSON.parse(body); }
      catch { throw new Error(`${adapter.label} returned an unexpected JSON response.`); }
    } catch (error) { abortCheck(signal); if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function readDetails() {
    for (const [id] of detailRoles) {
      abortCheck(signal);
      if (done.has(id)) continue;
      onProgress(`Reading ${adapter.label} role details ${done.size + 1} of ${detailRoles.size}…`);
      try {
        const payload = await request(`https://${adapter.host}/api/pcsx/position_details?position_id=${id}&domain=${adapter.domain}&hl=en&queried_location=United%20States`);
        const details = payload?.data;
        if (payload?.status !== 200 || idOf(details) !== id || typeof details.name !== 'string') throw new Error(`${adapter.label} returned unexpected role details.`);
        if (adapter.isSoftwareRole(details)) jobs.set(id, { ...adapter.normalizeJob(details, url), detailsRead: true });
        else jobs.delete(id);
        done.add(id); result.detailsFetched++;
      } catch (error) {
        abortCheck(signal);
        result.errors.push({ phase: 'details', roleId: id, error: error.message, ...(error.status && { status: error.status }), ...(error.retryAt && { retryAt: error.retryAt }) });
        if (error.status === 403 || retryable(error)) {
          result.enrichmentStoppedEarly = error.message;
          if (!complete) result.stoppedEarly = `Search paused while reading role details: ${error.message}`;
          if (retryable(error)) result.continuation = saveCursor(complete ? 'details' : 'search', error);
          return false;
        }
        done.add(id);
      }
    }
    return true;
  }
  // Some providers throttle detail requests heavily. Finish their catalog first
  // so an unfinished detail queue cannot keep the search at the same page.
  // Previously enriched jobs and every pending detail ID remain in the cursor.
  const listingsFirst = Boolean(adapter.listingsFirst);
  let detailsPaused = resume && (!listingsFirst || complete) ? !await readDetails() : false;
  for (; !complete && !detailsPaused && nextPage <= pages;) {
    onProgress(`Fetching ${adapter.label} US page ${nextPage}${result.totalResults && result.pageSize ? ` of ${Math.ceil(result.totalResults / result.pageSize)}` : ''}…`);
    try {
      let search;
      for (let attempt = 0; attempt < 3; attempt++) {
        search = adapter.parseSearch(await request(adapter.buildSearchUrl(url, offset)));
        if (search.positions.length || !(Math.max(result.totalResults || 0, search.totalResults) > offset)) break;
        if (attempt === 2) throw Object.assign(new Error(`${adapter.label} returned an empty page before all listings were read.`), { transient: true });
        if (Date.now() + 1000 >= deadline) throw new Error('Fetch time budget reached.');
        await pause(1000, signal);
      }
      const ids = search.positions.map(idOf).join('|');
      if (search.positions.length && ids === previousIds) throw new Error(`${adapter.label} repeated a results page.`);
      previousIds = ids;
      result.pagesFetched++; nextPage++;
      if (search.positions.length) { result.resultPagesFetched++; result.pageSize = Math.max(result.pageSize || 0, search.positions.length); }
      if (search.totalResults > 0 || result.totalResults === null) result.totalResults = search.totalResults;
      offset += search.positions.length; result.listingCount = offset;
      for (const role of search.positions) {
        if (!/^\d{1,20}$/.test(idOf(role)) || !adapter.isSoftwareRole(role)) continue;
        jobs.set(idOf(role), jobs.get(idOf(role)) || adapter.normalizeJob(role, url));
        if (detailRoles.size < maxDetails && !detailRoles.has(idOf(role))) detailRoles.set(idOf(role), role);
      }
      onProgress(`${adapter.label}: ${jobs.size} US software engineering roles collected; ${offset} listings read.`);
      complete = !search.positions.length || offset >= result.totalResults;
    } catch (error) {
      abortCheck(signal);
      result.stoppedEarly = error.message;
      result.errors.push({ phase: 'search', page: nextPage, error: error.message, ...(error.status && { status: error.status }), ...(error.retryAt && { retryAt: error.retryAt }) });
      if (retryable(error)) result.continuation = saveCursor('search', error);
      break;
    }
    if (complete || (!listingsFirst && result.pagesFetched % 10 === 0)) detailsPaused = !await readDetails();
  }
  if (!complete && !result.stoppedEarly) { result.stoppedEarly = `Page limit reached (${pages}); more ${adapter.label} results may be available.`; result.continuation = saveCursor('search'); }
  result.detailsRequested = detailRoles.size;
  // A page ceiling is a safe pause, so enrich that page's jobs too. A denied,
  // throttled, or failed request must stop without making more network requests.
  if (!detailsPaused && (!result.stoppedEarly || !result.errors.length) && (!listingsFirst || complete)) await readDetails();
  if (!complete && !result.enrichmentStoppedEarly) result.enrichmentStoppedEarly = listingsFirst
    ? 'Salary and experience details will be collected after all search pages are read.'
    : 'Search is incomplete; saved role details will continue on the next fetch.';
  result.detailsCompleted = done.size; result.detailsRemaining = detailRoles.size - done.size;
  if (!result.enrichmentStoppedEarly && jobs.size > maxDetails) result.enrichmentStoppedEarly = `Details limited to ${maxDetails} matching roles; remaining salary and experience fields may be unknown.`;
  result.totalPages = result.pageSize && result.totalResults !== null ? Math.ceil(result.totalResults / result.pageSize) : result.totalResults === 0 ? 0 : null;
  if (result.continuation) result.continuation.detailsDone = [...done];
  result.resumeState = { detailRoles: [...detailRoles.values()], previousIds, maxDetails, requestDelayMs, lastRequestAt: lastRequest };
  result.jobs = [...jobs.values()];
  return result;
}
