import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEnabledSources } from '../lib/collect.js';
import { aggregateSnapshots, summarize } from '../lib/store.js';
import { MICROSOFT_US_SOURCE_URL } from '../lib/microsoft.js';
import { canonicalNvidiaUrl } from '../lib/nvidia.js';

const epoch = Date.UTC(2026, 9, 10, 6);
const microsoft = { id: 'microsoft', name: 'Microsoft Careers · US', provider: 'microsoft', url: MICROSOFT_US_SOURCE_URL, enabled: true };
const nvidia = { id: 'nvidia', name: 'NVIDIA Careers · US', provider: 'nvidia', url: canonicalNvidiaUrl(), enabled: true };
const dataFor = (source, extra = {}) => ({
  fetchedAt: new Date(epoch).toISOString(), provider: source.provider,
  sourceId: source.id, sourceName: source.name, sourceUrl: source.url, effectiveUrl: source.url,
  jobs: [{ id: '101', company: source.provider, provider: source.provider, location: 'United States' }],
  pagesFetched: 1, pagesRequested: 500, resultPagesFetched: 1, pageSize: 10,
  listingCount: 10, totalResults: 10, totalPages: 1, errors: [], stoppedEarly: null,
  detailsFetched: 0, detailsRequested: 1, detailsCompleted: 0, detailsRemaining: 1,
  enrichmentStoppedEarly: null, continuation: null,
  resumeState: { detailRoles: [{ id: '101' }], previousIds: '101', maxDetails: 1000 },
  ...extra,
});
const coolingData = (source, retryAt) => dataFor(source, {
  totalResults: 20, totalPages: 2,
  stoppedEarly: `${source.provider} returned HTTP 429.`,
  errors: [{ phase: 'search', page: 2, status: 429, error: 'Rate limited.', retryAt }],
  continuation: { phase: 'search', nextPage: 2, offset: 10, detailsDone: [], retryAt },
});

function fixture(sources, initial = []) {
  const snapshots = initial.map((data, index) => ({ ...structuredClone(data), id: `saved-${String(index + 1).padStart(4, '0')}` }));
  const records = [];
  const store = {
    async list() { return snapshots.map(summarize).reverse(); },
    async load(id) { return structuredClone(snapshots.find(data => data.id === id)); },
    async save(data) {
      const saved = { ...structuredClone(data), id: `saved-${String(snapshots.length + 1).padStart(4, '0')}` };
      snapshots.push(saved);
      return summarize(saved);
    },
    async recordFetch(id, result) { records.push({ id, ...result }); },
    async aggregate() { return aggregateSnapshots(snapshots, sources); },
  };
  return { store, snapshots, records };
}

test('all-source collection fetches ready sources before waiting for a saved Microsoft cooldown', async () => {
  const sources = [microsoft, nvidia];
  const retryAt = new Date(epoch + 30000).toISOString();
  const { store, snapshots } = fixture(sources, [coolingData(microsoft, retryAt)]);
  const calls = [], waits = [];
  let currentTime = epoch;
  const aggregate = await collectEnabledSources({ store, sources, now: () => currentTime,
    wait: async (ms, signal) => { assert.equal(signal, undefined); waits.push(ms); currentTime += ms; },
    scrape: async options => {
      calls.push(options.provider);
      if (options.provider === 'microsoft') {
        assert.ok(currentTime >= Date.parse(retryAt), 'Microsoft must not be retried before its deadline');
        assert.equal(options.resume.id, 'saved-0001');
        assert.equal(options.resume.continuation.offset, 10);
      }
      return dataFor(sources.find(source => source.provider === options.provider));
    },
  });
  assert.deepEqual(calls, ['nvidia', 'microsoft']);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 30000);
  assert.equal(snapshots.length, 3);
  assert.equal(aggregate.jobCount, 2);
  assert.equal(aggregate.sourceCoverage.find(source => source.provider === 'microsoft').continuation, null);
});

test('a new Microsoft throttle checkpoint resumes automatically after its required cooldown', async () => {
  const sources = [microsoft, nvidia];
  const { store } = fixture(sources);
  const calls = [], waits = [];
  let currentTime = epoch, microsoftCalls = 0;
  await collectEnabledSources({ store, sources, now: () => currentTime,
    wait: async ms => { waits.push(ms); currentTime += ms; },
    scrape: async options => {
      calls.push(options.provider);
      if (options.provider === 'microsoft' && ++microsoftCalls === 1) {
        return coolingData(microsoft, new Date(currentTime + 60000).toISOString());
      }
      if (options.provider === 'microsoft') {
        assert.equal(options.resume.continuation.offset, 10);
        assert.ok(currentTime >= Date.parse(options.resume.continuation.retryAt));
      }
      return dataFor(sources.find(source => source.provider === options.provider));
    },
  });
  assert.deepEqual(calls, ['microsoft', 'nvidia', 'microsoft']);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 60000);
});

test('a throttle before the first Microsoft page saves its deadline and resumes the initial offset', async () => {
  const sources = [microsoft];
  const { store, snapshots } = fixture(sources);
  let currentTime = epoch, calls = 0;
  await collectEnabledSources({ store, sources, now: () => currentTime,
    wait: async ms => { currentTime += ms; },
    scrape: async options => {
      calls++;
      if (calls === 1) {
        return dataFor(microsoft, {
          jobs: [], pagesFetched: 0, resultPagesFetched: 0, listingCount: 0,
          totalResults: null, totalPages: null, pageSize: null,
          detailsRequested: 0, detailsRemaining: 0,
          stoppedEarly: 'Microsoft returned HTTP 429.',
          errors: [{ phase: 'search', page: 1, status: 429, error: 'Rate limited.', retryAt: new Date(currentTime + 1000).toISOString() }],
          continuation: { phase: 'search', nextPage: 1, offset: 0, detailsDone: [], retryAt: new Date(currentTime + 1000).toISOString() },
          resumeState: { detailRoles: [], previousIds: '', maxDetails: 1000 },
        });
      }
      assert.equal(options.resume.pagesFetched, 0);
      assert.equal(options.resume.continuation.offset, 0);
      assert.ok(currentTime >= Date.parse(options.resume.continuation.retryAt));
      return dataFor(microsoft);
    },
  });
  assert.equal(calls, 2);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].pagesFetched, 0);
});

test('cooldowns beyond the configured waiting budget retain the checkpoint and still fetch other sources', async () => {
  const sources = [microsoft, nvidia];
  const { store, snapshots, records } = fixture(sources, [coolingData(microsoft, new Date(epoch + 120001).toISOString())]);
  const calls = [], waits = [];
  const aggregate = await collectEnabledSources({ store, sources, now: () => epoch, maxCooldownWaitMs: 120000,
    wait: async ms => { waits.push(ms); },
    scrape: async options => { calls.push(options.provider); return dataFor(nvidia); },
  });
  assert.deepEqual(calls, ['nvidia']);
  assert.deepEqual(waits, []);
  assert.equal(snapshots.length, 2);
  assert.equal(records.some(record => record.id === 'microsoft' && record.status === 'error'), false);
  assert.equal(aggregate.sourceCoverage.find(source => source.provider === 'microsoft').continuation.retryAt, new Date(epoch + 120001).toISOString());
});

test('cancelling an all-source cooldown wait stops without retrying or marking the saved checkpoint as failed', async () => {
  const sources = [microsoft];
  const { store, snapshots, records } = fixture(sources, [coolingData(microsoft, new Date(epoch + 1000).toISOString())]);
  const controller = new AbortController();
  const reason = new Error('Fetch cancelled.');
  await assert.rejects(collectEnabledSources({ store, sources, now: () => epoch, signal: controller.signal,
    wait: async (_ms, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort(reason);
      throw signal.reason;
    },
    scrape: async () => assert.fail('Microsoft must not be requested after cancellation'),
  }), error => error === reason);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(records, []);
});

test('cooldown retries remain bounded by the per-source request limit', async () => {
  const sources = [microsoft];
  const { store, snapshots } = fixture(sources);
  let currentTime = epoch, calls = 0;
  await collectEnabledSources({ store, sources, now: () => currentTime, maxRequests: 2,
    wait: async ms => { currentTime += ms; },
    scrape: async () => {
      calls++;
      const checkpoint = coolingData(microsoft, new Date(currentTime + 1000).toISOString());
      checkpoint.pagesFetched = calls;
      checkpoint.resultPagesFetched = calls;
      checkpoint.listingCount = calls * 10;
      checkpoint.totalResults = 100;
      checkpoint.continuation.nextPage = calls + 1;
      checkpoint.continuation.offset = calls * 10;
      return checkpoint;
    },
  });
  assert.equal(calls, 2);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1).continuation.offset, 20);
});
