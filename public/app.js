const SVG_NS = "http://www.w3.org/2000/svg";
const LEVEL_ORDER = ["Intern", "Junior", "Mid", "Senior", "Staff", "Principal", "Not specified"];
const PAGE_SIZE = 25;
const MAX_LOCATIONS = 20;
const MAX_REFRESH_REQUESTS = 8;
const MAX_NO_PROGRESS = 3;
const PROVIDER_NAMES = { apple: "Apple", nvidia: "NVIDIA", microsoft: "Microsoft" };
const state = {
  jobs: [],
  filters: { company: "", level: "", location: "", specialty: "", days: 0 },
  search: "",
  sort: { key: "postedDate", asc: false },
  visibleRows: PAGE_SIZE,
};
const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => "$" + Math.round(n / 1000) + "k";
const fmtInt = (n) => n.toLocaleString("en-US");
const fmtDateTime = (iso) => {
  if (!iso) return "Not fetched yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Not fetched yet" : date.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
};

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sortedNums = (arr) => arr.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

async function getJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

let sources = [];
let fetchIndex = { defaultId: null, fetches: [] };
let refreshRunning = false;
let sourceBusy = false;
let editingSourceId = null;
let currentFetchId = null;
let fetchLoadVersion = 0;
let currentFetchData = null;
let savedDataSyncRunning = false;
let initialLoadComplete = false;

function isPartial(summary) {
  if (typeof summary.partial === "boolean") return summary.partial;
  return Boolean(summary.stoppedEarly || summary.failedPages ||
    summary.errors?.some(error => error.phase !== "details"));
}

function searchScopeKey(value) {
  const url = new URL(value);
  url.hash = "";
  url.searchParams.delete("page");
  url.searchParams.delete("sort");
  url.search = new URLSearchParams([...url.searchParams].sort(([keyA, valueA], [keyB, valueB]) =>
    keyA.localeCompare(keyB) || valueA.localeCompare(valueB))).toString();
  return url.href;
}

function usedExtraTeamFilters(data) {
  if (!data.sourceUrl || !data.effectiveUrl) return false;
  try {
    return !new URL(data.sourceUrl).searchParams.get("team") && Boolean(new URL(data.effectiveUrl).searchParams.get("team"));
  } catch { return false; }
}

function pageCoverage(data) {
  const pages = Number.isFinite(data.resultPagesFetched) ? data.resultPagesFetched : data.pagesFetched;
  if (!Number.isFinite(pages)) return "";
  return `${fmtInt(pages)}${Number.isFinite(data.totalPages) && data.totalPages > 0 ? ` of ${fmtInt(data.totalPages)}` : ""} ${pages === 1 && !(data.totalPages > 1) ? "page" : "pages"}`;
}

function listingCoverage(data) {
  if (!Number.isFinite(data.listingCount)) return "";
  return `${fmtInt(data.listingCount)}${Number.isFinite(data.totalResults) ? ` of ${fmtInt(data.totalResults)}` : ""} source listings`;
}

function collectionCoverage(data) {
  const listings = listingCoverage(data);
  const pages = pageCoverage(data);
  const read = listings ? `Read ${listings}${pages ? ` across ${pages}` : ""}` : pages ? `Read ${pages}` : "";
  return `${read ? `${read}; kept` : "Kept"} ${fmtInt(data.jobCount ?? state.jobs.length)} software engineering roles.`;
}

function pendingFetch(sourceId) {
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return null;
  const latest = fetchIndex.fetches
    .filter((entry) => entry.sourceId === sourceId)
    .sort((a, b) => (Date.parse(b.fetchedAt) || 0) - (Date.parse(a.fetchedAt) || 0))[0];
  if (!latest?.continuation || !latest.sourceUrl) return null;
  try {
    if (latest.effectiveUrl && searchScopeKey(latest.sourceUrl) !== searchScopeKey(latest.effectiveUrl)) return null;
    return new URL(latest.sourceUrl).href === new URL(source.url).href ? latest : null;
  } catch { return null; }
}

function continuationDescription(summary) {
  return summary.continuation?.phase === "details"
    ? "reading the remaining job details"
    : `continuing from page ${summary.continuation?.nextPage || (summary.pagesFetched || 0) + 1}`;
}

function continuationRetryTime(summary) {
  const retryAt = summary.continuation?.retryAt;
  return typeof retryAt === 'number' ? retryAt : Date.parse(retryAt);
}

function continuationNotice(summary) {
  if (!summary.continuation) return '';
  const retryTime = continuationRetryTime(summary);
  if (Number.isFinite(retryTime)) {
    return retryTime > Date.now()
      ? ` Cooldown until ${fmtDateTime(retryTime)}. ${refreshRunning
        ? 'The active fetch is waiting and will resume this saved checkpoint after the cooldown.'
        : 'Fetch source can resume this saved checkpoint after the cooldown.'}`
      : refreshRunning
        ? ' The cooldown has ended; the active fetch can continue this saved checkpoint.'
        : ' The cooldown has ended. Fetch source is ready to resume this saved checkpoint.';
  }
  return refreshRunning ? ' The active fetch continues this saved checkpoint.' : ' Fetch source continues this saved checkpoint.';
}

function fetchStopReason(summary, action = 'collection') {
  const reason = summary.error || summary.stoppedEarly || '';
  return /HTTP\s*429/i.test(reason)
    ? `The source paused ${action} because it limited requests.`
    : reason;
}

function formatProgressMessage(message) {
  return String(message).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, timestamp => fmtDateTime(timestamp));
}

function updateFetchNotice(data) {
  if (data.scope === 'all') {
    const note = $('fetch-note');
    note.hidden = !(data.sourceCoverage || []).length;
    note.classList.toggle('warning', Boolean(data.partial));
    note.innerHTML = (data.sourceCoverage || []).map(source => {
      const summary = collectionCoverage(source);
      const detailReason = source.provider === 'microsoft' && source.continuation?.phase === 'search'
        ? 'Salary and experience details will be collected after the search completes.'
        : /HTTP\s*429/i.test(source.enrichmentStoppedEarly || '') && /HTTP\s*429/i.test(source.stoppedEarly || '')
          ? '' : fetchStopReason({ stoppedEarly: source.enrichmentStoppedEarly }, 'job detail requests');
      const details = Number.isFinite(source.detailsRequested) && source.detailsRequested > 0
        ? ` Details read: ${fmtInt(source.detailsFetched || 0)} of ${fmtInt(source.detailsRequested)}. ${detailReason}` : '';
      const unavailable = source.failedDetails > 0
        ? ` ${fmtInt(source.failedDetails)} job detail ${source.failedDetails === 1 ? 'request' : 'requests'} failed; salary and experience may be unknown for those roles.` : '';
      const pending = continuationNotice(source) + (source.continuation?.phase === 'search' ? ' Search is incomplete.' : '');
      return `<p><strong>${escapeHtml(source.sourceName)}</strong>: ${escapeHtml(summary)} <a href="${safeUrl(source.effectiveUrl || source.sourceUrl)}" target="_blank" rel="noopener noreferrer">Search ↗</a>${escapeHtml(` ${fetchStopReason(source)}${pending}${details}${unavailable}`)}</p>`;
    }).join('');
    return;
  }
  const partial = isPartial(data);
  const resumable = Boolean(data.continuation);
  const extraFilters = usedExtraTeamFilters(data);
  const paragraphs = [];
  const note = $("fetch-note");
  note.hidden = false;
  note.classList.toggle("warning", partial || extraFilters);
  if (resumable) {
    paragraphs.push(escapeHtml(`Saved ${fmtInt(data.jobCount ?? state.jobs.length)} jobs.${continuationNotice(data)} Next step: ${continuationDescription(data)}.`));
  } else if (partial) {
    paragraphs.push(escapeHtml(`Partial fetch: ${fetchStopReason(data) || "Some search pages failed; results may be missing."}`));
  }
  paragraphs.push(escapeHtml(collectionCoverage(data)) + (data.effectiveUrl
    ? ` <a href="${safeUrl(data.effectiveUrl)}" target="_blank" rel="noopener noreferrer">Actual careers search ↗</a>`
    : ""));
  if (extraFilters) paragraphs.push("Saved search used extra team filters; fetch again to scan this source in full.");
  if (Number.isFinite(data.detailsFetched) && Number.isFinite(data.detailsRequested) &&
      (data.detailsFetched < data.detailsRequested || data.enrichmentStoppedEarly)) {
    const reason = fetchStopReason({ stoppedEarly: data.enrichmentStoppedEarly }, 'job detail requests');
    paragraphs.push(escapeHtml(`Job details read: ${fmtInt(data.detailsFetched)} of ${fmtInt(data.detailsRequested)} requested.${reason ? ` ${reason}` : ""}`));
  }
  note.innerHTML = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("");
}

function updateRefreshButton() {
  const available = sources.some((source) => source.enabled);
  $("refresh").disabled = refreshRunning || sourceBusy || !available;
  $("refresh").textContent = refreshRunning ? "Fetching…" : "Fetch source";
  $("empty-fetch").disabled = refreshRunning || sourceBusy || !available;
  $("empty-fetch").textContent = "Fetch source";
  $("source-save").disabled = refreshRunning || sourceBusy;
  document.querySelectorAll("[data-source-action]").forEach((button) => {
    const source = sources.find((item) => item.id === button.dataset.sourceId);
    button.disabled = refreshRunning || sourceBusy || (button.dataset.sourceAction === "fetch" && !source?.enabled);
    if (button.dataset.sourceAction === "fetch") button.textContent = "Fetch source";
  });
  document.querySelectorAll("[data-source-toggle]").forEach((input) => { input.disabled = refreshRunning || sourceBusy; });
}

function showRefreshStatus(message, isError = false) {
  $("refresh-status").textContent = message;
  $("refresh-status").classList.toggle("error", isError);
  $("refresh-status").setAttribute("role", isError ? "alert" : "status");
}

function sourceStatus(message, isError = false) {
  $("source-status").textContent = message;
  $("source-status").classList.toggle("error", isError);
  $("source-status").setAttribute("role", isError ? "alert" : "status");
}

async function loadSources(shouldApply) {
  const data = await getJson("/api/sources");
  if (shouldApply && !shouldApply()) return;
  sources = data.sources || [];
  renderSourceList();
  updateRefreshButton();
}

function renderSourceList() {
  $("source-list").innerHTML = sources.length ? sources.map((source) => {
    const status = source.lastFetchedAt
      ? `${source.lastStatus === "partial" ? "Partial fetch" : source.lastStatus === "error" || source.lastStatus === "failed" ? "Fetch failed" : "Last fetch"}: ${fmtDateTime(source.lastFetchedAt)}${source.lastJobCount != null ? ` · ${fmtInt(source.lastJobCount)} posts` : ""}`
      : "Not fetched yet";
    return `<article class="source-item">
      <div class="source-detail"><div class="source-title"><h3>${escapeHtml(source.name)}</h3><span class="provider-badge">${escapeHtml(PROVIDER_NAMES[source.provider] || source.provider || "Careers")} Jobs</span></div>
        <a class="source-url" href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)} ↗</a>
        <p class="form-help">${escapeHtml(status)}</p></div>
      <div class="source-controls"><label class="check-label"><input type="checkbox" data-source-toggle="${escapeHtml(source.id)}" ${source.enabled ? "checked" : ""} aria-label="Enable ${escapeHtml(source.name)}" /> Enabled</label>
        <button type="button" data-source-action="fetch" data-source-id="${escapeHtml(source.id)}" ${source.enabled ? "" : "disabled"}>Fetch</button>
        <button class="ghost" type="button" data-source-action="edit" data-source-id="${escapeHtml(source.id)}">Edit</button>
        <button class="ghost danger" type="button" data-source-action="delete" data-source-id="${escapeHtml(source.id)}">Delete</button>
      </div></article>`;
  }).join("") : '<p class="form-help">No scraping sources yet. Add an Apple, NVIDIA, or Microsoft careers link below.</p>';
  updateRefreshButton();
}

function resetSourceForm() {
  editingSourceId = null;
  $("source-form").reset();
  $("source-form-heading").textContent = "Add a careers source";
  $("source-save").textContent = "Add source";
  $("source-cancel").hidden = true;
}

async function saveSource(event) {
  event.preventDefault();
  if (sourceBusy || refreshRunning) return;
  const payload = { name: $("source-name").value.trim(), url: $("source-url").value.trim(), enabled: $("source-enabled").checked };
  sourceBusy = true;
  updateRefreshButton();
  sourceStatus("Saving source…");
  try {
    const editing = Boolean(editingSourceId);
    await getJson(editing ? `/api/sources/${encodeURIComponent(editingSourceId)}` : "/api/sources", {
      method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    resetSourceForm();
    await loadSources();
    if (currentFetchData?.scope === 'all') await showFetch('all');
    sourceStatus(editing ? "Source updated." : "Source added. Fetch it to load jobs into the dashboard.");
  } catch (error) {
    sourceStatus(`Couldn't save source: ${error.message}`, true);
  } finally {
    sourceBusy = false;
    updateRefreshButton();
  }
}

async function changeSource(id, method, payload) {
  if (sourceBusy || refreshRunning) return;
  sourceBusy = true;
  updateRefreshButton();
  try {
    await getJson(`/api/sources/${encodeURIComponent(id)}`, {
      method, ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
    });
    if (editingSourceId === id && method === "DELETE") resetSourceForm();
    await loadSources();
    await loadFetchList();
    await showFetch('all');
    sourceStatus(method === "DELETE" ? "Source deleted. Saved fetch history is retained." : "Source updated.");
  } catch (error) {
    sourceStatus(`Couldn't update source: ${error.message}`, true);
    renderSourceList();
  } finally {
    sourceBusy = false;
    updateRefreshButton();
  }
}

function selectTab(name, focus = false) {
  for (const tabName of ["dashboard", "sources"]) {
    const selected = name === tabName;
    $("tab-" + tabName).setAttribute("aria-selected", String(selected));
    $("tab-" + tabName).tabIndex = selected ? 0 : -1;
    $("panel-" + tabName).hidden = !selected;
  }
  hideTooltip();
  if (focus) $("tab-" + name).focus();
  if (name === "dashboard") render();
}

function renderSavedFetch() {
  const data = currentFetchData?.scope === 'all' ? currentFetchData : null;
  const label = data?.fetchedAt
    ? `Latest saved jobs · ${fmtDateTime(data.fetchedAt)}`
    : 'No saved jobs yet';
  $('fetch-select').replaceChildren(new Option(label, 'all'));
  $('fetch-select').value = 'all';
}

async function loadFetchList(justSaved, shouldApply) {
  const data = await getJson("/api/fetches");
  if (shouldApply && !shouldApply()) return;
  fetchIndex = data;
  if (justSaved) {
    const savedIndex = fetchIndex.fetches.findIndex((entry) => entry.id === justSaved.id);
    if (savedIndex === -1) fetchIndex.fetches.unshift(justSaved);
    else fetchIndex.fetches[savedIndex] = justSaved;
    if (!isPartial(justSaved)) fetchIndex.defaultId = justSaved.id;
  }
  renderSavedFetch();
  $("fetch-select").disabled = false;
  updateRefreshButton();
}

async function showFetch(id, shouldApply) {
  const version = ++fetchLoadVersion;
  const data = await getJson(id === 'all' ? '/api/jobs?source=all' : `/api/fetches/${encodeURIComponent(id)}`);
  if (version !== fetchLoadVersion || (shouldApply && !shouldApply())) return;
  setData(data);
  const url = new URL(location.href);
  if (data.id === fetchIndex.defaultId) url.searchParams.delete("fetch");
  else url.searchParams.set("fetch", data.id);
  history.replaceState(null, "", url);
}

function canSyncSavedData() {
  const active = document.activeElement;
  const editingInput = active?.matches('input, textarea, select, [contenteditable="true"]');
  const sourceFormDirty = $('source-name').value.trim() || $('source-url').value.trim() || !$('source-enabled').checked;
  return initialLoadComplete && document.visibilityState !== 'hidden' &&
    !refreshRunning && !sourceBusy && !editingSourceId && !editingInput && !sourceFormDirty;
}

async function syncSavedDataOnReturn() {
  if (document.visibilityState === 'hidden') return;
  if (currentFetchData && !refreshRunning) updateFetchNotice(currentFetchData);
  if (savedDataSyncRunning || !canSyncSavedData()) return;
  savedDataSyncRunning = true;
  try {
    const results = await Promise.allSettled([
      loadSources(canSyncSavedData), loadFetchList(undefined, canSyncSavedData),
    ]);
    if (!canSyncSavedData() || results.some(result => result.status === 'rejected')) return;
    await showFetch('all', canSyncSavedData);
  } catch {
    // Preserve the saved view when the local server is temporarily unavailable.
  } finally {
    savedDataSyncRunning = false;
  }
}

function setData(data) {
  currentFetchId = data.id;
  currentFetchData = data;
  state.jobs = (data.jobs || []).map((job) => {
    const salaryMin = Number.isFinite(job.salaryMin) && job.salaryMin > 0 ? job.salaryMin : null;
    const salaryMax = Number.isFinite(job.salaryMax) && job.salaryMax > 0 ? job.salaryMax : null;
    const usdAnnualSalary = job.salaryCurrency === "USD" && job.salaryPeriod !== "hour";
    return {
      ...job,
      title: job.title || "Untitled role", company: job.company || "Unknown company", location: job.location || "Not specified",
      level: job.level || "Not specified", specialty: job.specialty || "General", postedDate: job.postedDate || "",
      salaryMin, salaryMax,
      salaryMid: usdAnnualSalary ? (salaryMin && salaryMax ? (salaryMin + salaryMax) / 2 : salaryMin || salaryMax) : null,
      yearsExperience: Number.isFinite(job.yearsExperience) && job.yearsExperience >= 0 ? job.yearsExperience : null,
    };
  });
  renderSavedFetch();
  $("empty-dashboard").hidden = state.jobs.length > 0;
  $("empty-dashboard").querySelector("h2").textContent = "No software engineering jobs in this fetch";
  $("empty-dashboard").querySelector("p").textContent = "Fetch source, or edit your careers search links in Scraping sources.";
  updateFetchNotice(data);
  renderSources(data);
  const uniq = (key) => [...new Set(state.jobs.map((job) => job[key]))];
  fillSelect('f-company', uniq('company').sort());
  state.filters.company = $('f-company').value;
  fillSelect("f-level", uniq("level").sort((a, b) => rank(a) - rank(b)));
  fillDatalist("f-location-options", uniq("location").sort());
  fillSelect("f-specialty", uniq("specialty").sort());
  for (const [id, key] of [["f-level", "level"], ["f-specialty", "specialty"]]) state.filters[key] = $(id).value;
  state.filters.location = $("f-location").value;
  state.visibleRows = PAGE_SIZE;
  render();
  updateRefreshButton();
}

async function readRefreshStream(response, onSourceEvent) {
  if (!response.body) throw new Error("The server did not return a progress stream.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let final = null;
  const readLine = async (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress") showRefreshStatus(formatProgressMessage(event.message));
    if (onSourceEvent && ['source_done', 'source_error'].includes(event.type)) await onSourceEvent(event);
    if (event.type === "done" || event.type === "error") final = event;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) await readLine(line);
    }
    await readLine(buffer);
    return final;
  } finally { reader.releaseLock(); }
}

function hasFetchProgress(previous, next) {
  return !previous || ["pagesFetched", "detailsFetched", "detailsCompleted", "jobCount"].some((key) => (next[key] || 0) > (previous[key] || 0));
}

async function waitForContinuation(summary) {
  const retryTime = continuationRetryTime(summary);
  const until = Math.max(Date.now() + 600, Number.isFinite(retryTime) ? retryTime : 0);
  while (Date.now() < until) {
    const remaining = until - Date.now();
    showRefreshStatus(remaining > 1000
      ? `Saved ${fmtInt(summary.jobCount)} jobs. Waiting ${Math.ceil(remaining / 1000)}s before ${continuationDescription(summary)}…`
      : `Saved ${fmtInt(summary.jobCount)} jobs; ${continuationDescription(summary)}…`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
  }
}

async function startRefresh(sourceId) {
  if (typeof sourceId !== 'string' || sourceId === 'all') return startRefreshAll();
  if (refreshRunning || sourceBusy) return;
  const id = sourceId;
  const source = sources.find((item) => item.id === id && item.enabled);
  if (!source) {
    showRefreshStatus("Enable a careers source in Scraping sources before fetching.", true);
    selectTab("sources");
    return;
  }
  let checkpoint = pendingFetch(id);
  let lastSaved = checkpoint;
  let noProgress = 0;
  let pauseReason = "";
  refreshRunning = true;
  updateRefreshButton();
  if (currentFetchData) updateFetchNotice(currentFetchData);
  showRefreshStatus(checkpoint
    ? `Resuming ${source.name}; ${continuationDescription(checkpoint)}…`
    : `Fetching ${source.name}…`);
  try {
    for (let request = 0; request < MAX_REFRESH_REQUESTS; request++) {
      if (checkpoint) await waitForContinuation(checkpoint);
      const query = new URLSearchParams({ source: id });
      if (checkpoint) query.set("resume", checkpoint.id);
      const response = await fetch(`/api/refresh?${query}`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const result = await readRefreshStream(response);
      if (!result) throw new Error("The connection closed before a final result was received. Reload to check saved fetches.");
      if (result.type === "error") throw new Error(result.error);
      if (!result.fetch?.id) throw new Error("The server returned no saved fetch.");
      noProgress = hasFetchProgress(lastSaved, result.fetch) ? 0 : noProgress + 1;
      lastSaved = result.fetch;
      await loadFetchList(lastSaved);
      await loadSources();
      await showFetch(lastSaved.id);
      selectTab("dashboard");
      if (!lastSaved.continuation) break;
      checkpoint = lastSaved;
      showRefreshStatus(`Saved ${fmtInt(lastSaved.jobCount)} jobs; ${continuationDescription(lastSaved)}…`);
      sourceStatus("Checkpoint saved. Continuing the fetch automatically…");
      if (noProgress >= MAX_NO_PROGRESS) {
        pauseReason = "The source returned no additional pages or job details after three attempts.";
        break;
      }
    }
    const partial = isPartial(lastSaved);
    if (lastSaved.continuation) {
      const message = `Paused with ${fmtInt(lastSaved.jobCount)} jobs. ${pauseReason ? `${pauseReason} ` : ""}Resume fetch continues ${lastSaved.continuation.phase === "details" ? "reading job details" : `from page ${lastSaved.continuation.nextPage || (lastSaved.pagesFetched || 0) + 1}`}.`;
      showRefreshStatus(message, Boolean(pauseReason));
      sourceStatus(message, Boolean(pauseReason));
    } else if (partial) {
      const message = `Saved ${fmtInt(lastSaved.jobCount)} jobs. ${lastSaved.stoppedEarly || "Some search pages failed; review the dashboard notice."}`;
      showRefreshStatus(message, true);
      sourceStatus(message, true);
    } else {
      const pages = pageCoverage(lastSaved);
      const listings = listingCoverage(lastSaved);
      const message = `Saved ${fmtInt(lastSaved.jobCount)} software engineering jobs from ${source.name}${pages ? ` after reading ${pages}` : ""}.${listings ? ` Reviewed ${listings}.` : ""}${lastSaved.enrichmentStoppedEarly ? ` ${lastSaved.enrichmentStoppedEarly}` : ""}`;
      showRefreshStatus(message);
      sourceStatus("Fetch saved and available in the dashboard.");
    }
  } catch (error) {
    const message = lastSaved
      ? `Fetch paused with ${fmtInt(lastSaved.jobCount)} saved jobs: ${error.message}`
      : `Fetch failed: ${error.message}`;
    showRefreshStatus(message, true);
    sourceStatus(message, true);
    // A lost stream may still have saved a checkpoint on the server.
    await Promise.allSettled([loadSources(), loadFetchList()]);
  } finally {
    refreshRunning = false;
    if (currentFetchData) updateFetchNotice(currentFetchData);
    updateRefreshButton();
  }
}

async function startRefreshAll() {
  if (refreshRunning || sourceBusy) return;
  if (!sources.some(source => source.enabled)) { showRefreshStatus('Enable a source before fetching.', true); selectTab('sources'); return; }
  refreshRunning = true;
  updateRefreshButton(); showRefreshStatus('Fetching source…');
  try {
    const response = await fetch('/api/refresh?source=all', { method: 'POST' });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || `HTTP ${response.status}`); }
    const result = await readRefreshStream(response, async () => {
      await Promise.all([loadSources(), loadFetchList()]);
      await showFetch('all'); selectTab('dashboard');
    });
    if (!result || result.type === 'error') throw new Error(result?.error || 'The connection closed. Saved checkpoints will resume on the next fetch.');
    await Promise.all([loadSources(), loadFetchList()]);
    await showFetch('all'); selectTab('dashboard');
    const resumes = result.fetch.sourceCoverage.filter(source => source.continuation).map(source => {
      const retryTime = continuationRetryTime(source);
      return `${source.sourceName}: ${Number.isFinite(retryTime) && retryTime > Date.now()
        ? `resume after ${fmtDateTime(retryTime)}` : 'ready to resume with Fetch source'}.`;
    }).join(' ');
    const message = `Saved ${fmtInt(result.fetch.jobCount)} software engineering jobs across ${result.fetch.sourceCoverage.length} enabled sources.${result.fetch.partial ? ' Some sources are incomplete; see the coverage notice.' : ' All search pages are complete.'}${resumes ? ` ${resumes}` : ''}`;
    showRefreshStatus(message, result.fetch.partial); sourceStatus(message, result.fetch.partial);
  } catch (error) {
    showRefreshStatus(`Fetch stopped: ${error.message}`, true);
    await Promise.allSettled([loadSources(), loadFetchList(), showFetch('all')]);
  } finally {
    refreshRunning = false; updateRefreshButton();
    if (currentFetchData) updateFetchNotice(currentFetchData);
  }
}

function showEmpty() {
  state.jobs = [];
  currentFetchId = null;
  currentFetchData = null;
  renderSavedFetch();
  $("empty-dashboard").hidden = false;
  $("fetch-note").hidden = true;
  $("sources").textContent = "Fetch all enabled sources to view software engineering postings. Salary and experience statistics use stated values only.";
  render();
}

async function init() {
  $("refresh").addEventListener("click", () => startRefresh());
  $("empty-fetch").addEventListener("click", () => startRefresh());
  $("source-form").addEventListener("submit", saveSource);
  $("source-cancel").addEventListener("click", resetSourceForm);
  $("source-list").addEventListener("change", (event) => {
    if (event.target.matches("[data-source-toggle]")) changeSource(event.target.dataset.sourceToggle, "PATCH", { enabled: event.target.checked });
  });
  $("source-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-source-action]");
    if (!button || refreshRunning || sourceBusy) return;
    const source = sources.find((item) => item.id === button.dataset.sourceId);
    if (!source) return;
    if (button.dataset.sourceAction === "fetch") startRefreshAll();
    if (button.dataset.sourceAction === "delete") changeSource(source.id, "DELETE");
    if (button.dataset.sourceAction === "edit") {
      editingSourceId = source.id;
      $("source-name").value = source.name;
      $("source-url").value = source.url;
      $("source-enabled").checked = source.enabled;
      $("source-form-heading").textContent = "Edit careers source";
      $("source-save").textContent = "Save changes";
      $("source-cancel").hidden = false;
      $("source-name").focus();
    }
  });
  const tabNames = ["dashboard", "sources"];
  tabNames.forEach((name, index) => {
    $("tab-" + name).addEventListener("click", () => {
      selectTab(name);
      if (name === 'dashboard') syncSavedDataOnReturn();
    });
    $("tab-" + name).addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      selectTab(event.key === "Home" ? tabNames[0] : event.key === "End" ? tabNames[1] : tabNames[1 - index], true);
    });
  });
  $("fetch-select").addEventListener("change", async (event) => {
    const select = event.target;
    const selectedId = select.value;
    select.disabled = true;
    try {
      await showFetch(selectedId);
      if (!refreshRunning) showRefreshStatus("");
    } catch (error) {
      showRefreshStatus(`Couldn't load that fetch: ${error.message}`, true);
      select.value = currentFetchId || "";
    } finally { select.disabled = !fetchIndex.fetches.length; }
  });
  const bind = (id, key, parse = (value) => value) => $(id).addEventListener("change", (event) => {
    state.filters[key] = parse(event.target.value);
    state.visibleRows = PAGE_SIZE;
    render();
  });
  bind("f-level", "level");
  bind('f-company', 'company');
  bind("f-specialty", "specialty");
  bind("f-days", "days", Number);
  $("f-location").addEventListener("input", (event) => {
    state.filters.location = event.target.value;
    state.visibleRows = PAGE_SIZE;
    render();
  });
  $("f-reset").addEventListener("click", () => {
    state.filters = { company: "", level: "", location: "", specialty: "", days: 0 };
    state.search = "";
    state.visibleRows = PAGE_SIZE;
    ["f-company", "f-level", "f-location", "f-specialty", "search"].forEach((id) => { $(id).value = ""; });
    $("f-days").value = "0";
    render();
  });
  $("search").addEventListener("input", (event) => {
    state.search = event.target.value.toLowerCase();
    state.visibleRows = PAGE_SIZE;
    render();
  });
  $("more").addEventListener("click", () => { state.visibleRows += PAGE_SIZE; renderTable(filtered()); });
  $("sort").addEventListener("change", (event) => {
    const [key, direction] = event.target.value.split(":");
    state.sort = { key, asc: direction === "asc" };
    renderTable(filtered());
  });
  document.querySelectorAll("th[data-sort]").forEach((header) => header.querySelector("button").addEventListener("click", () => {
    const key = header.dataset.sort;
    state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : ["title", "company", "location"].includes(key) };
    renderTable(filtered());
  }));
  document.addEventListener("pointerdown", (event) => { if (event.pointerType !== "mouse") hideTooltip(); }, true);
  window.addEventListener("scroll", hideTooltip, { passive: true });
  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });
  window.addEventListener('focus', syncSavedDataOnReturn);
  document.addEventListener('visibilitychange', syncSavedDataOnReturn);
  showEmpty();
  updateRefreshButton();
  const results = await Promise.allSettled([loadSources(), loadFetchList()]);
  if (results[0].status === "rejected") {
    sourceStatus(`Couldn't load sources: ${results[0].reason.message}`, true);
  }
  if (results[1].status === "rejected") {
    showRefreshStatus(`Couldn't load fetch history: ${results[1].reason.message}`, true);
    initialLoadComplete = true;
    return;
  }
  try { await showFetch('all'); }
  catch (error) { showRefreshStatus(`Couldn't load saved jobs: ${error.message}`, true); }
  updateRefreshButton();
  if (results[0].status === "rejected") showRefreshStatus(`Couldn't load sources: ${results[0].reason.message}`, true);
  initialLoadComplete = true;
}
const rank = (level) => {
  const i = LEVEL_ORDER.indexOf(level);
  return i === -1 ? 99 : i;
};

function fillSelect(id, values) {
  // Rebuilt on every data load: keep the "All …" option and the current choice if it still exists.
  const sel = $(id);
  const current = sel.value;
  sel.length = 1;
  for (const v of values) sel.add(new Option(v, v));
  sel.value = values.includes(current) ? current : "";
}

// Rebuilt on every data load; suggestions only, so the current text (a substring search) is untouched.
function fillDatalist(id, values) {
  const list = $(id);
  list.innerHTML = "";
  for (const v of values) list.appendChild(new Option(v, v));
}

function filtered() {
  const { company, level, location, specialty, days } = state.filters;
  const locationQuery = location.trim().toLowerCase();
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : "";
  return state.jobs.filter(
    (j) =>
      (!company || j.company === company) &&
      (!level || j.level === level) &&
      (!locationQuery || j.location.toLowerCase().includes(locationQuery)) &&
      (!specialty || j.specialty === specialty) &&
      (!cutoff || j.postedDate >= cutoff) &&
      (!state.search || [j.title, j.company, j.location].some((value) => value.toLowerCase().includes(state.search)))
  );
}

// ---- render ----------------------------------------------------------------

function render() {
  const jobs = filtered();
  renderTiles(jobs);
  renderYearsChart(jobs);
  renderSalaryChart(jobs);
  renderLocations(jobs);
  renderTable(jobs);
}

function renderTiles(jobs) {
  const salaries = sortedNums(jobs.map((j) => j.salaryMid));
  const years = sortedNums(jobs.map((j) => j.yearsExperience));
  $("k-count").textContent = fmtInt(jobs.length);
  $("k-salary").textContent = salaries.length ? fmtMoney(quantile(salaries, 0.5)) : "–";
  $("k-salary-range").textContent = salaries.length
    ? `Middle 50%: ${fmtMoney(quantile(salaries, 0.25))} – ${fmtMoney(quantile(salaries, 0.75))} · ${fmtInt(salaries.length)} annual USD salaries stated`
    : jobs.length ? "No annual USD salary data stated" : "";
  $("k-years").textContent = years.length ? `${+quantile(years, 0.5).toFixed(1)} yrs` : "–";
  const unstated = jobs.length - years.length;
  $("k-years-range").textContent = years.length
    ? `Middle 50%: ${+quantile(years, 0.25).toFixed(1)} – ${+quantile(years, 0.75).toFixed(1)} yrs` +
      (unstated ? ` · ${fmtInt(unstated)} posts don't say` : "")
    : jobs.length ? "Experience requirements not stated" : "";
}

// Postings that don't state years of experience are left out of the per-year charts.
function groupByYears(jobs) {
  const withYears = jobs.filter((j) => Number.isFinite(j.yearsExperience));
  const maxYears = Math.max(0, ...withYears.map((j) => j.yearsExperience));
  const groups = new Map(Array.from({ length: Math.min(51, Math.floor(maxYears) + 1) }, (_, years) => [years, { years, jobs: [] }]));
  for (const job of withYears) {
    if (!groups.has(job.yearsExperience)) groups.set(job.yearsExperience, { years: job.yearsExperience, jobs: [] });
    groups.get(job.yearsExperience).jobs.push(job);
  }
  return [...groups.values()].sort((a, b) => a.years - b.years);
}

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceMax(v, steps = 4) {
  if (v <= 0) return steps;
  const raw = v / steps;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return step * steps;
}

function chartFrame(container, yMax, yFormat, xTitle) {
  container.innerHTML = "";
  const width = container.clientWidth;
  const height = container.clientHeight;
  const m = { top: 8, right: 8, bottom: 38, left: 48 };
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${container.id === "chart-years" ? "Number of job posts" : "Median USD salary"} by years of experience required` }, container);
  const iw = Math.max(1, width - m.left - m.right);
  const ih = Math.max(1, height - m.top - m.bottom);
  const g = el("g", { transform: `translate(${m.left},${m.top})` }, svg);
  const y = (v) => ih - (v / yMax) * ih;

  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    el("line", { x1: 0, x2: iw, y1: y(v), y2: y(v), stroke: i === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }, g);
    const t = el("text", { x: -8, y: y(v), dy: "0.32em", "text-anchor": "end", class: "axis-label" }, g);
    t.textContent = yFormat(v);
  }
  const title = el("text", { x: iw / 2, y: ih + 34, "text-anchor": "middle", class: "axis-title" }, g);
  title.textContent = xTitle;
  return { svg, g, iw, ih, y };
}

function renderYearsChart(jobs) {
  const container = $("chart-years");
  const groups = groupByYears(jobs);
  if (!groups.some((d) => d.jobs.length)) return (container.innerHTML = `<div class="empty">${jobs.length ? "These postings do not state years of experience" : "No postings match these filters"}</div>`);

  const yMax = niceMax(Math.max(...groups.map((d) => d.jobs.length)));
  const { g, iw, ih, y } = chartFrame(container, yMax, (v) => fmtInt(v), "Years of experience required");
  const band = iw / groups.length;
  const gap = Math.max(2, band * 0.2);
  const barW = band - gap;
  const labelEvery = Math.ceil(groups.length / Math.max(1, Math.floor(iw / 28)));

  groups.forEach((d, i) => {
    const x = i * band + gap / 2;
    const h = ih - y(d.jobs.length);
    if (h > 0) el("path", { d: roundedTopBar(x, y(d.jobs.length), barW, h, Math.min(4, barW / 2)), fill: "var(--series)" }, g);
    if (i % labelEvery === 0) {
      const t = el("text", { x: x + barW / 2, y: ih + 16, "text-anchor": "middle", class: "axis-label" }, g);
      t.textContent = d.years;
    }
    const hit = el("rect", { x: i * band, y: 0, width: band, height: ih, fill: "transparent" }, g);
    hoverable(hit, () => {
      const sal = sortedNums(d.jobs.map((j) => j.salaryMid));
      return tip(`${d.years} ${d.years === 1 ? "year" : "years"} experience`, [
        ["Job posts", fmtInt(d.jobs.length)],
        ["Share", jobs.length ? ((d.jobs.length / jobs.length) * 100).toFixed(1) + "%" : "–"],
        ["Median salary", sal.length ? fmtMoney(quantile(sal, 0.5)) : "–"],
      ]);
    });
  });
}

function roundedTopBar(x, y, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderSalaryChart(jobs) {
  const container = $("chart-salary");
  // Only plot years with enough postings for a meaningful median/percentiles.
  const points = groupByYears(jobs)
    .map((d) => ({ years: d.years, n: d.jobs.length, sal: sortedNums(d.jobs.map((j) => j.salaryMid)) }))
    .filter((d) => d.sal.length >= 3)
    .map((d) => ({ ...d, p25: quantile(d.sal, 0.25), p50: quantile(d.sal, 0.5), p75: quantile(d.sal, 0.75) }));
  if (points.length < 2) return (container.innerHTML = '<div class="empty">Not enough salary data for these filters</div>');

  const maxYears = points[points.length - 1].years;
  const minYears = points[0].years;
  const yMax = niceMax(Math.max(...points.map((p) => p.p75)));
  const { g, iw, ih, y } = chartFrame(container, yMax, (v) => (v ? fmtMoney(v) : "$0"), "Years of experience required");
  const x = (v) => ((v - minYears) / Math.max(1, maxYears - minYears)) * iw;

  const labelEvery = Math.ceil((maxYears - minYears + 1) / Math.max(1, Math.floor(iw / 28)));
  for (let v = minYears; v <= maxYears; v += labelEvery) {
    const t = el("text", { x: x(v), y: ih + 16, "text-anchor": "middle", class: "axis-label" }, g);
    t.textContent = v;
  }

  const bandPath =
    points.map((p, i) => `${i ? "L" : "M"}${x(p.years)},${y(p.p75)}`).join("") +
    [...points].reverse().map((p) => `L${x(p.years)},${y(p.p25)}`).join("") + "Z";
  el("path", { d: bandPath, fill: "var(--band)", opacity: 0.6 }, g);
  el("path", {
    d: points.map((p, i) => `${i ? "L" : "M"}${x(p.years)},${y(p.p50)}`).join(""),
    fill: "none", stroke: "var(--series)", "stroke-width": 2, "stroke-linejoin": "round",
  }, g);

  const crosshair = el("line", { y1: 0, y2: ih, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" }, g);
  const dot = el("circle", { r: 4.5, fill: "var(--series)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, g);
  const overlay = el("rect", { x: 0, y: 0, width: iw, height: ih, fill: "transparent" }, g);

  const nearest = (evt) => {
    const rect = overlay.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    return points.reduce((best, p) => (Math.abs(x(p.years) - px) < Math.abs(x(best.years) - px) ? p : best));
  };
  hoverable(
    overlay,
    (evt) => {
      const p = nearest(evt);
      crosshair.setAttribute("x1", x(p.years));
      crosshair.setAttribute("x2", x(p.years));
      dot.setAttribute("cx", x(p.years));
      dot.setAttribute("cy", y(p.p50));
      crosshair.setAttribute("visibility", "visible");
      dot.setAttribute("visibility", "visible");
      return tip(`${p.years} ${p.years === 1 ? "year" : "years"} experience`, [
        ["Median", fmtMoney(p.p50)],
        ["75th pct", fmtMoney(p.p75)],
        ["25th pct", fmtMoney(p.p25)],
        ["Job posts", fmtInt(p.n)],
      ]);
    },
    () => {
      crosshair.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
    }
  );
}

function renderLocations(jobs) {
  const container = $("chart-location");
  const byLoc = new Map();
  for (const j of jobs) {
    if (!byLoc.has(j.location)) byLoc.set(j.location, []);
    byLoc.get(j.location).push(j);
  }
  const rows = [...byLoc.entries()]
    .map(([name, list]) => ({
      name,
      count: list.length,
      salary: quantile(sortedNums(list.map((j) => j.salaryMid)), 0.5),
      years: quantile(sortedNums(list.map((j) => j.yearsExperience)), 0.5),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_LOCATIONS);
  if (!rows.length) return (container.innerHTML = '<div class="empty">No postings match these filters</div>');

  const max = rows[0].count;
  container.innerHTML =
    '<div class="hdr">Location</div><div class="hdr">Job posts</div><div class="hdr val">Med. yrs</div><div class="hdr val">Med. salary</div>' +
    rows
      .map(
        (r) => `<div class="loc-row">
          <div class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
          <div class="bar-track"><div class="bar" style="width:calc(${(r.count / max) * 100}% - 48px)"></div><span class="val" style="margin-left:8px">${fmtInt(r.count)}</span></div>
          <div class="val">${Number.isFinite(r.years) ? +r.years.toFixed(1) : "–"}</div>
          <div class="val">${Number.isFinite(r.salary) ? fmtMoney(r.salary) : "–"}</div>
        </div>`
      )
      .join("");
}

function renderTable(jobs) {
  const q = state.search;
  const { key, asc } = state.sort;
  const rows = jobs
    .filter((j) => !q || j.title.toLowerCase().includes(q) || j.company.toLowerCase().includes(q) || j.location.toLowerCase().includes(q))
    .sort((a, b) => {
      const av = a[key] ?? "";
      const bv = b[key] ?? "";
      if (av === "" || bv === "") return (av === "") - (bv === ""); // missing values always last
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      if (cmp) return asc ? cmp : -cmp;
      return (b.postedDate || "").localeCompare(a.postedDate || ""); // ties: newest first
    });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const sorted = th.dataset.sort === key;
    th.classList.toggle("sorted", sorted);
    th.classList.toggle("asc", sorted && asc);
    if (sorted) th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
  // Keep the "Sort by" menu in step with header clicks; text columns show as a one-off "Title: A–Z" style entry.
  const sortSel = $("sort");
  const sortValue = `${key}:${asc ? "asc" : "desc"}`;
  if ([...sortSel.options].some((o) => o.value === sortValue)) {
    sortSel.value = sortValue;
  } else {
    const custom = sortSel.querySelector('option[value="custom"]');
    custom.textContent = `${document.querySelector(`th[data-sort="${key}"]`).textContent}: ${asc ? "A–Z" : "Z–A"}`;
    sortSel.value = "custom";
  }

  const shown = rows.slice(0, state.visibleRows);
  $("rows").innerHTML = shown
    .map(
      (j) => `<tr>
        <td>${escapeHtml(j.title)}</td>
        <td>${escapeHtml(j.company)}</td>
        <td>${escapeHtml(j.location)}</td>
        <td class="num${Number.isFinite(j.yearsExperience) ? "" : " none"}" data-label="Exp">${Number.isFinite(j.yearsExperience) ? `${j.yearsExperience}+` : "–"}</td>
        <td class="num${j.salaryMin || j.salaryMax ? "" : " none"}">${escapeHtml(formatJobSalary(j))}</td>
        <td class="num" data-label="Posted">${escapeHtml(j.postedDate || "–")}</td>
        <td>${j.url ? `<a href="${safeUrl(j.url)}" target="_blank" rel="noopener noreferrer" aria-label="View ${escapeHtml(j.title)} at ${escapeHtml(j.company)}">View post ↗</a>` : '<span class="muted">No link</span>'}</td>
      </tr>`
    )
    .join("") || '<tr class="empty-row"><td colspan="7">No job posts match these filters.</td></tr>';
  $("row-info").textContent = `Showing ${fmtInt(shown.length)} of ${fmtInt(rows.length)}`;
  $("more").hidden = shown.length >= rows.length;
}

function renderSources(data) {
  if (data.scope === 'all') {
    $('sources').textContent = `Sources: ${(data.sourceCoverage || []).map(source => source.sourceName).join(', ')}. Software engineering roles only. NVIDIA and Microsoft locations are limited to the United States. Salary statistics use stated annual USD amounts; hourly ranges appear in the job table. Experience statistics use stated values only; unknown values are excluded.`;
    return;
  }
  const source = sources.find((item) => item.id === data.sourceId);
  const name = escapeHtml(data.sourceName || source?.name || "Apple Jobs");
  const url = safeUrl(data.sourceUrl || source?.url || "https://jobs.apple.com/en-us/search");
  const coverage = Number.isFinite(data.detailsFetched) && Number.isFinite(data.detailsRequested)
    ? ` Detail pages read: ${fmtInt(data.detailsFetched)} of ${fmtInt(data.detailsRequested)} requested, for ${fmtInt(state.jobs.length)} collected roles.${data.enrichmentStoppedEarly ? ` ${escapeHtml(data.enrichmentStoppedEarly)}` : ""}`
    : "";
  $("sources").innerHTML = `<strong>Source:</strong> <a href="${url}" target="_blank" rel="noopener noreferrer">${name}</a>. Software engineering roles fetched ${escapeHtml(fmtDateTime(data.fetchedAt))}${isPartial(data) ? " (partial fetch)" : ""}.${coverage} Salary and experience are extracted from stated requirements; missing values are excluded from statistics. Salary charts use annual USD amounts only; hourly ranges appear in the job table. Seniority is shown only when stated; otherwise it is “Not specified”.`;
}

function formatJobSalary(job) {
  if (!job.salaryMin && !job.salaryMax) return "–";
  const currency = job.salaryCurrency || "USD";
  const hourly = job.salaryPeriod === "hour";
  const format = (value) => {
    if (hourly) {
      const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
      return currency === "USD" ? `$${amount}` : `${currency} ${amount}`;
    }
    if (currency === "USD") return fmtMoney(value);
    return `${currency} ${fmtInt(Math.round(value))}`;
  };
  const range = job.salaryMin && job.salaryMax ? `${format(job.salaryMin)} – ${format(job.salaryMax)}` : format(job.salaryMin || job.salaryMax);
  return hourly ? `${range}/hr` : range;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch { return "#"; }
}

// ---- tooltip ---------------------------------------------------------------

function tip(title, rows) {
  return `<div class="tt-title">${escapeHtml(title)}</div>` +
    rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join("");
}

let activeLeave = null; // onLeave of the element whose tooltip is showing

function hideTooltip() {
  $("tooltip").hidden = true;
  if (activeLeave) activeLeave();
  activeLeave = null;
}

// Mouse: the tooltip follows the pointer. Touch: a tap shows it above the finger and a sideways drag scrubs;
// the next tap elsewhere or a scroll hides it (see init).
function hoverable(node, content, onLeave = () => {}) {
  const tooltip = $("tooltip");
  const show = (evt) => {
    if (activeLeave !== onLeave) {
      if (activeLeave) activeLeave();
      activeLeave = onLeave;
    }
    tooltip.innerHTML = content(evt);
    tooltip.hidden = false;
    const { width, height } = tooltip.getBoundingClientRect();
    let left, top;
    if (evt.pointerType === "mouse") {
      left = evt.clientX + 14;
      top = evt.clientY + 14;
      if (left + width > window.innerWidth - 8) left = evt.clientX - width - 14;
      if (top + height > window.innerHeight - 8) top = evt.clientY - height - 14;
    } else {
      left = Math.min(Math.max(8, evt.clientX - width / 2), window.innerWidth - width - 8);
      top = evt.clientY - height - 24;
      if (top < 8) top = evt.clientY + 24;
    }
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  };
  node.addEventListener("pointermove", show);
  node.addEventListener("pointerdown", (evt) => {
    // A touch is captured by the element it starts on; release it so a drag moves across the bars.
    if (node.hasPointerCapture(evt.pointerId)) node.releasePointerCapture(evt.pointerId);
    show(evt);
  });
  node.addEventListener("pointerleave", (evt) => {
    if (evt.pointerType === "mouse") hideTooltip();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

init().catch((err) => {
  showRefreshStatus(`Failed to load data: ${err.message}`, true);
});

