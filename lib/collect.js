import { continuationFor, scrapeSource } from './providers.js';

const waitForCooldown = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('Fetch cancelled.'));
  const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Fetch cancelled.')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

export async function collectEnabledSources({ store, sources, scrape = scrapeSource, pages = 500, timeBudgetMs = 240000,
  signal, onEvent = () => {}, maxRequests = 8, resumeId, maxCooldownWaitMs = 120000, now = Date.now, wait = waitForCooldown }) {
  if (!Number.isFinite(maxCooldownWaitMs) || maxCooldownWaitMs < 0) throw new Error('Invalid cooldown wait limit.');
  const pending = sources.filter(source => source.enabled).map(source => ({ source, requests: 0, stalled: 0, finished: false }));
  let waitRemaining = maxCooldownWaitMs;
  const abortCheck = () => { if (signal?.aborted) throw signal.reason || new Error('Fetch cancelled.'); };
  async function collect(state) {
    const { source } = state;
    abortCheck();
    try {
      if (!state.initialized) {
        const latest = (await store.list()).find(entry => entry.sourceId === source.id && entry.sourceUrl === source.url);
        state.resume = resumeId ? await store.load(resumeId) : latest?.continuation ? await store.load(latest.id) : null;
        if (state.resume && (state.resume.sourceId !== source.id || state.resume.sourceUrl !== source.url || !continuationFor(state.resume))) throw new Error('This checkpoint does not match the selected source.');
        state.previous = state.resume ? [state.resume.pagesFetched, state.resume.detailsFetched, state.resume.detailsCompleted, state.resume.jobs.length] : [0,0,0,0];
        state.initialized = true;
      }
      for (; state.requests < maxRequests;) {
        const resume = state.resume;
        const cursor = resume && continuationFor(resume);
        state.retryAt = cursor?.retryAt;
        if (cursor?.retryAt && Date.parse(cursor.retryAt) > now()) {
          onEvent({ type: 'progress', sourceId: source.id, retryAt: cursor.retryAt,
            message: `${source.name}: paused until ${cursor.retryAt}; continuing other sources first.` });
          return;
        }
        if (cursor?.phase === 'search' && cursor.nextPage > pages) throw new Error('Increase the configured page limit before resuming this source.');
        state.requests++;
        const data = await scrape({ url: source.url, provider: source.provider, sourceId: source.id, pages, timeBudgetMs, resume, signal,
          onProgress: message => onEvent({ type: 'progress', sourceId: source.id, message: `${source.name}: ${message}` }) });
        if (signal?.aborted) throw signal.reason;
        const snapshot = { ...data, provider: source.provider, source: source.provider, sourceId: source.id, sourceName: source.name,
          sourceUrl: source.url, resumedFrom: resume?.id ?? null, query: 'software engineering' };
        const checkpoint = continuationFor(snapshot);
        if (!data.jobs.length && (data.errors?.length || data.stoppedEarly) && !checkpoint) throw new Error(data.errors?.[0]?.error || data.stoppedEarly || 'No jobs collected.');
        const summary = await store.save(snapshot);
        await store.recordFetch(source.id, { status: summary.partial ? 'partial' : 'success', jobCount: summary.jobCount });
        onEvent({ type: 'source_done', sourceId: source.id, sourceName: source.name, fetch: summary });
        if (!summary.continuation) { state.finished = true; return; }
        const progress = [summary.pagesFetched || 0, summary.detailsFetched || 0, summary.detailsCompleted || 0, summary.jobCount];
        state.stalled = progress.some((value, index) => value > (state.previous[index] || 0)) ? 0 : state.stalled + 1;
        state.previous = progress;
        state.resume = await store.load(summary.id);
        if (state.stalled >= 3 || state.requests >= maxRequests) {
          onEvent({ type: 'progress', message: `${source.name}: checkpoint saved; fetch again to continue.` });
          state.finished = true; return;
        }
      }
      state.finished = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      await store.recordFetch(source.id, { status: 'error' });
      onEvent({ type: 'source_error', sourceId: source.id, sourceName: source.name, error: error.message });
      state.finished = true;
    }
  }
  // Fetch available sources first, then revisit rate-limited checkpoints without
  // holding up another provider or making requests before its retry deadline.
  for (const state of pending) await collect(state);
  while (pending.some(state => !state.finished)) {
    abortCheck();
    const state = pending.filter(state => !state.finished).sort((a, b) => Date.parse(a.retryAt) - Date.parse(b.retryAt))[0];
    const remaining = Math.max(0, Date.parse(state.retryAt) - now());
    if (remaining > waitRemaining) {
      onEvent({ type: 'progress', sourceId: state.source.id, retryAt: state.retryAt,
        message: `${state.source.name}: checkpoint saved. Cooldown until ${state.retryAt}; fetch again after that time.` });
      state.finished = true; continue;
    }
    if (remaining) {
      onEvent({ type: 'progress', sourceId: state.source.id, retryAt: state.retryAt,
        message: `${state.source.name}: waiting for the cooldown until ${state.retryAt}; this fetch will resume automatically.` });
      const step = Math.min(30000, remaining);
      await wait(step, signal);
      waitRemaining -= step;
      abortCheck();
    } else await collect(state);
  }
  return store.aggregate();
}
