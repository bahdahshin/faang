import test from 'node:test';
import assert from 'node:assert/strict';
import { MICROSOFT_US_SOURCE_URL, canonicalMicrosoftUrl, buildMicrosoftSearchUrl, parseMicrosoftSearch,
  microsoftUsLocations, isMicrosoftSoftwareRole, normalizeMicrosoftJob, scrapeMicrosoft, continuationForMicrosoft } from '../lib/microsoft.js';

const role = (id, name = 'Software Engineer', locations = ['United States, Washington, Redmond']) => ({
  id, name, locations, department: 'Software Engineering', postedTs: 1791566340,
});
const liveDescription = `<b>Overview</b><p>Our platform has 25 years of history.</p>
  <b>Qualifications</b><p>Required Qualifications:</p><ul><li>Bachelor's Degree in Computer Science AND 4+ years technical engineering experience with coding in C++ OR equivalent experience.</li></ul>
  <p>Other Requirements:</p><p>A background check is required every 2 years thereafter.</p>
  <p>Preferred Qualifications:</p><p>Master's Degree AND 6+ years technical engineering experience OR Bachelor's Degree AND 8+ years experience.</p>
  <p>Software Engineering IC4 - The typical base pay range for this role across the U.S. is USD $119,800 - $234,700 per year.
  There is a different range applicable to specific work locations within the San Francisco Bay area and New York City metropolitan area,
  and the base pay range for this role in those locations is USD $160,200 - $261,000 per year.</p>
  <p>Certain roles may be eligible for benefits and other compensation. A signing bonus can be $20,000 - $30,000.</p>`;
const searchResponse = (positions, count) => new Response(JSON.stringify({status:200,data:{positions,count}}), {headers:{'Content-Type':'application/json'}});
const detailResponse = (id, extras = {}) => new Response(JSON.stringify({status:200,data:{...role(id),jobDescription:liveDescription,...extras}}), {headers:{'Content-Type':'application/json'}});

test('Microsoft source canonicalization always targets the explicit US search', () => {
  assert.equal(canonicalMicrosoftUrl('https://apply.careers.microsoft.com/careers'), MICROSOFT_US_SOURCE_URL);
  assert.equal(canonicalMicrosoftUrl('https://apply.careers.microsoft.com/careers?location=United%20States'), MICROSOFT_US_SOURCE_URL);
  assert.equal(canonicalMicrosoftUrl('https://apply.careers.microsoft.com/careers?country_code=US&start=10&page=2'), MICROSOFT_US_SOURCE_URL);
  for (const value of [
    'https://apply.careers.microsoft.com/careers?location=India',
    'https://apply.careers.microsoft.com/careers?location=US&location=Canada',
    'https://apply.careers.microsoft.com/careers?country=Canada',
    'https://apply.careers.microsoft.com/careers?countryCode=CA',
    'https://apply.careers.microsoft.com/careers?country_code=CA',
    'http://apply.careers.microsoft.com/careers',
    'https://apply.careers.microsoft.com.evil.example/careers',
    'https://u@apply.careers.microsoft.com/careers',
    'https://apply.careers.microsoft.com:1234/careers',
    'https://apply.careers.microsoft.com/careers/job/123',
  ]) assert.throws(() => canonicalMicrosoftUrl(value), value);
  const api = new URL(buildMicrosoftSearchUrl('https://apply.careers.microsoft.com/careers?query=compiler', 20));
  assert.equal(api.hostname, 'apply.careers.microsoft.com');
  assert.equal(api.searchParams.get('domain'), 'microsoft.com');
  assert.equal(api.searchParams.get('location'), 'United States');
  assert.equal(api.searchParams.get('start'), '20');
  assert.equal(api.searchParams.get('query'), 'compiler');
});

test('Microsoft country checks support live raw/standardized locations and retain only US locations', () => {
  assert.deepEqual(microsoftUsLocations(role(1, 'Software Engineer', ['United States, Multiple Locations, Multiple Locations'])), ['United States']);
  assert.deepEqual(microsoftUsLocations(role(1, 'Software Engineer', ['United States, Washington, Redmond','India, Karnataka, Bengaluru'])), ['Redmond, Washington, United States']);
  assert.deepEqual(microsoftUsLocations({locations:['United States, California, Mountain View','Canada, Ontario, Toronto']}), ['Mountain View, California, United States']);
  assert.deepEqual(microsoftUsLocations({locations:['Redmond'],standardizedLocations:['Redmond, WA, US','Toronto, ON, CA']}), ['Redmond, WA, United States']);
  assert.deepEqual(microsoftUsLocations({locations:['Remote - US']}), ['Remote, United States']);
  assert.deepEqual(microsoftUsLocations({locations:['Seattle']}), []);
  assert.deepEqual(microsoftUsLocations({locations:['India, Karnataka, Bengaluru'],standardizedLocations:['Bengaluru, KA, IN']}), []);
});

test('Microsoft uses strict engineering titles and excludes managers, support, sales and foreign roles', () => {
  for (const title of ['Software Engineer II','Senior Software Engineer - Azure','Principal Software Engineer','Site Reliability Engineer','Machine Learning Engineer','Security Engineer']) assert.equal(isMicrosoftSoftwareRole(role(1,title)), true, title);
  for (const title of ['Software Engineering Manager','Principal Applied Scientist','Technical Program Manager','Solution Engineer - Security','Technical Support Engineer','Hardware Engineer','Cloud Solution Architect']) assert.equal(isMicrosoftSoftwareRole(role(1,title)), false, title);
  assert.equal(isMicrosoftSoftwareRole({...role(1),efcustomTextRoletype:['People Manager']}), false);
  assert.equal(isMicrosoftSoftwareRole(role(1,'Software Engineer',['India, Karnataka, Bengaluru'])), false);
});

test('Microsoft normalizes published USD pay envelopes and required experience from a live description', () => {
  const job = normalizeMicrosoftJob({...role(1970393557024859,'Senior Software Engineer - Azure'),jobDescription:liveDescription});
  assert.equal(job.id, '1970393557024859');
  assert.equal(job.provider, 'microsoft');
  assert.equal(job.company, 'Microsoft');
  assert.equal(job.level, 'Senior');
  assert.equal(job.yearsExperience, 4);
  assert.equal(job.salaryMin, 119800);
  assert.equal(job.salaryMax, 261000);
  assert.equal(job.salaryCurrency, 'USD');
  assert.equal(job.salaryPeriod, 'year');
  assert.equal(job.location, 'Redmond, Washington, United States');
  assert.equal(job.url, 'https://apply.careers.microsoft.com/careers/job/1970393557024859');
  assert.ok(job.postedDate);
});

test('Microsoft experience considers required education alternatives but excludes preferred-only years and unrelated tenure', () => {
  const alternatives = normalizeMicrosoftJob({...role(1),jobDescription:"Required Qualifications: Bachelor's Degree AND 5+ years technical engineering experience OR Master's Degree AND 3+ years experience. Other Requirements: Background check every 2 years. Preferred Qualifications: 1 year with React."});
  assert.equal(alternatives.yearsExperience, 3);
  for (const description of [
    'Preferred Qualifications: 8 years of experience.',
    'Overview: We have 20 years of history. Required Qualifications: A degree or equivalent experience. Preferred Qualifications: 5 years of experience.',
    'Required Qualifications: C++ proficiency. Other Requirements: A screening check every 2 years.',
  ]) assert.equal(normalizeMicrosoftJob({...role(1),jobDescription:description}).yearsExperience, null, description);
  assert.equal(normalizeMicrosoftJob({...role(1),jobDescription:'Basic Qualifications: 5–7 years of software engineering experience. Preferred Qualifications: 2 years of Python.'}).yearsExperience, 5);
});

test('Microsoft hourly pay is preserved and bonus/equity/foreign amounts stay unknown', () => {
  const intern = normalizeMicrosoftJob({...role(2,'Software Engineering Intern'),jobDescription:'Required Qualifications: Currently pursuing a degree. The base pay range for this role across the U.S. is USD $30.50 - $59.75 per hour. Certain roles may be eligible for benefits and other compensation.'});
  assert.equal(intern.yearsExperience, null);
  assert.equal(intern.salaryMin, 30.5);
  assert.equal(intern.salaryMax, 59.75);
  assert.equal(intern.salaryPeriod, 'hour');
  for (const description of [
    'Required Qualifications: 4+ years of experience. Signing bonus range: USD $20,000 - $30,000. Equity awards are USD $40,000 - $50,000.',
    'Base salary is competitive. Signing bonus range: $20,000 - $30,000.',
    'The base pay range for this role is CAD $100,000 - $200,000 per year.',
    'Required Qualifications: Strong C++ skills.',
  ]) {
    const unknown = normalizeMicrosoftJob({...role(1),jobDescription:description});
    assert.equal(unknown.salaryMin, null, description);
    assert.equal(unknown.salaryMax, null, description);
    assert.equal(unknown.salaryCurrency, null, description);
  }
});

test('Microsoft search parser refuses malformed totals and response shapes', () => {
  assert.deepEqual(parseMicrosoftSearch({status:200,data:{positions:[role(1)],count:1}}), {positions:[role(1)],totalResults:1});
  for (const payload of [{status:500,data:{positions:[],count:0}},{status:200,data:{positions:[],count:-1}},{status:200,data:{count:1}}]) assert.throws(() => parseMicrosoftSearch(payload));
});

test('Microsoft pagination counts all raw listings while enriching only valid US engineering roles', async () => {
  const calls = [];
  const result = await scrapeMicrosoft({delayMs:0,fetchImpl:async value => {
    const url = new URL(value); calls.push(url);
    assert.equal(url.hostname, 'apply.careers.microsoft.com');
    assert.equal(url.searchParams.get('domain'), 'microsoft.com');
    if (url.pathname.endsWith('position_details')) {
      assert.equal(url.searchParams.get('queried_location'), 'United States');
      return detailResponse(Number(url.searchParams.get('position_id')));
    }
    assert.equal(url.searchParams.get('location'), 'United States');
    const offset = Number(url.searchParams.get('start'));
    if (offset === 0) return searchResponse([role(101),role(102,'Product Manager'),role(103,'Software Engineer',['India, Karnataka, Bengaluru'])],5);
    assert.equal(offset, 3);
    return searchResponse([role(104,'Senior Software Engineer'),role(105,'Hardware Engineer')],5);
  }});
  assert.equal(result.provider, 'microsoft');
  assert.equal(result.listingCount, 5);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.detailsFetched, 2);
  assert.equal(result.jobs.every(job => job.detailsRead && job.yearsExperience === 4 && job.salaryMin === 119800 && job.salaryMax === 261000), true);
  assert.equal(result.continuation, null);
  assert.equal(calls.filter(url => url.pathname.endsWith('/search')).length, 2);
});

test('Microsoft checkpoints resume unread offsets and saved details with the same country scope', async () => {
  const first = await scrapeMicrosoft({pages:1,maxDetails:1,delayMs:0,fetchImpl:async value => {
    assert.ok(new URL(value).pathname.endsWith('/search'), 'partial listing collection must not spend its requests on details');
    return searchResponse([role(101),role(102,'Product Manager')],3);
  }});
  assert.equal(first.continuation.phase, 'search');
  assert.equal(first.continuation.offset, 2);
  assert.equal(first.continuation.nextPage, 2);
  assert.equal(first.detailsFetched, 0);
  assert.equal(first.detailsRemaining, 1);
  assert.ok(continuationForMicrosoft(first));
  assert.equal(continuationForMicrosoft({...first,effectiveUrl:'https://apply.careers.microsoft.com/careers?location=India'}), null);
  const resumed = await scrapeMicrosoft({resume:first,maxDetails:1,delayMs:0,fetchImpl:async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('position_details')) {
      assert.equal(url.searchParams.get('position_id'), '101');
      return detailResponse(101);
    }
    assert.ok(url.pathname.endsWith('/search')); assert.equal(url.searchParams.get('start'),'2');
    return searchResponse([role(103,'Hardware Engineer')],3);
  }});
  assert.equal(resumed.jobs.length, 1);
  assert.equal(resumed.detailsFetched, 1);
  assert.equal(resumed.continuation, null);
});

test('Microsoft search resumes the unread listing offset before pending details and retains enriched saved roles', async () => {
  const first = await scrapeMicrosoft({pages:1,delayMs:0,fetchImpl:async value => {
    assert.ok(new URL(value).pathname.endsWith('/search'));
    return searchResponse([role(101),role(102)],4);
  }});
  assert.equal(first.detailsFetched, 0);
  assert.equal(first.resumeState.detailRoles.length, 2);
  // Model an older checkpoint that enriched one role before listing collection
  // finished. Its known salary/experience must survive the new search-first flow.
  first.jobs[0] = {...normalizeMicrosoftJob({...role(101),jobDescription:liveDescription}),detailsRead:true};
  first.detailsFetched = 1;
  first.detailsCompleted = 1;
  first.detailsRemaining = 1;
  first.continuation.detailsDone = ['101'];
  const requests = [];
  const resumed = await scrapeMicrosoft({resume:first,delayMs:0,fetchImpl:async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('position_details')) {
      const id = Number(url.searchParams.get('position_id'));
      requests.push(`detail:${id}`);
      return detailResponse(id);
    }
    requests.push(`search:${url.searchParams.get('start')}`);
    assert.equal(url.searchParams.get('start'), '2');
    return searchResponse([role(103),role(104,'Software Engineer',['India, Karnataka, Bengaluru'])],4);
  }});
  assert.deepEqual(requests, ['search:2','detail:102','detail:103']);
  assert.equal(resumed.listingCount, 4);
  assert.equal(resumed.jobs.length, 3);
  assert.equal(resumed.detailsFetched, 3);
  assert.equal(resumed.detailsRemaining, 0);
  assert.equal(resumed.resumeState.detailRoles.length, 3);
  assert.deepEqual(resumed.jobs.find(job => job.id === '101'), first.jobs[0]);
  assert.equal(resumed.jobs.every(job => job.detailsRead && job.yearsExperience === 4 && job.salaryMin === 119800), true);
  assert.equal(resumed.continuation, null);
});

test('Microsoft detail throttling after all listings preserves a detail-only continuation and complete search coverage', async () => {
  const requests = [];
  const first = await scrapeMicrosoft({delayMs:0,fetchImpl:async value => {
    const url = new URL(value);
    if (url.pathname.endsWith('position_details')) {
      const id = Number(url.searchParams.get('position_id'));
      requests.push(`detail:${id}`);
      return id === 101 ? detailResponse(101) : new Response('', {status:429,headers:{'Retry-After':'60'}});
    }
    requests.push('search:0');
    return searchResponse([role(101),role(102)],2);
  }});
  assert.deepEqual(requests, ['search:0','detail:101','detail:102']);
  assert.equal(first.listingCount, 2);
  assert.equal(first.pagesFetched, 1);
  assert.equal(first.stoppedEarly, null);
  assert.equal(first.detailsFetched, 1);
  assert.equal(first.detailsRemaining, 1);
  assert.equal(first.continuation.phase, 'details');
  assert.equal(first.continuation.offset, 2);
  assert.deepEqual(first.continuation.detailsDone, ['101']);
  assert.ok(Date.parse(first.continuation.retryAt) > Date.now());
  assert.ok(continuationForMicrosoft(first));
  await assert.rejects(scrapeMicrosoft({resume:first,delayMs:0,fetchImpl:async () => assert.fail('Cooldown must be honored')}), /cooldown/);

  const ready = structuredClone(first);
  ready.continuation.retryAt = new Date(Date.now() - 1).toISOString();
  const resumed = await scrapeMicrosoft({resume:ready,delayMs:0,fetchImpl:async value => {
    const url = new URL(value);
    assert.ok(url.pathname.endsWith('position_details'), 'complete listings must not be requested again');
    assert.equal(url.searchParams.get('position_id'), '102');
    return detailResponse(102);
  }});
  assert.equal(resumed.pagesFetched, 1);
  assert.equal(resumed.listingCount, 2);
  assert.equal(resumed.detailsFetched, 2);
  assert.equal(resumed.jobs.length, 2);
  assert.equal(resumed.continuation, null);
});

test('Microsoft HTTP 200 throttle text preserves the unread page and enforces a cooldown', async () => {
  let calls = 0;
  const result = await scrapeMicrosoft({delayMs:0,fetchImpl:async () => {
    calls++;
    return calls === 1 ? searchResponse(Array.from({length:10},(_,i) => role(i+1)),20) : new Response('Please try again later',{status:200});
  }});
  assert.equal(calls, 2);
  assert.equal(result.jobs.length, 10);
  assert.equal(result.listingCount, 10);
  assert.equal(result.continuation.phase, 'search');
  assert.equal(result.continuation.offset, 10);
  assert.equal(result.continuation.nextPage, 2);
  assert.ok(Date.parse(result.continuation.retryAt) > Date.now());
  assert.ok(continuationForMicrosoft(result));
  await assert.rejects(scrapeMicrosoft({resume:result,fetchImpl:async () => {throw new Error('Should not request during cooldown');}}), /cooldown/);
});

test('Microsoft denied detail requests stop without falling back to another endpoint', async () => {
  let calls = 0;
  const result = await scrapeMicrosoft({delayMs:0,fetchImpl:async value => {
    calls++;
    return new URL(value).pathname.endsWith('position_details') ? new Response('',{status:403}) : searchResponse([role(101)],1);
  }});
  assert.equal(calls, 2);
  assert.equal(result.jobs.length, 1);
  assert.match(result.enrichmentStoppedEarly, /403/);
  assert.equal(result.continuation, null);
});

test('Microsoft throttle checkpoints persist increased request spacing and the required retry deadline', async () => {
  const started = Date.now();
  let calls = 0;
  const result = await scrapeMicrosoft({delayMs:10,fetchImpl:async () => {
    calls++;
    return new Response('', {status:429,headers:{'Retry-After':'120'}});
  }});
  assert.equal(calls, 1);
  assert.equal(result.pagesFetched, 0);
  assert.equal(result.continuation.offset, 0);
  assert.equal(result.resumeState.requestDelayMs, 20);
  assert.ok(Number.isFinite(result.resumeState.lastRequestAt));
  assert.ok(result.resumeState.lastRequestAt >= started);
  assert.ok(Date.parse(result.continuation.retryAt) >= started + 120000);
  assert.ok(continuationForMicrosoft(result));

  const ready = structuredClone(result);
  ready.continuation.retryAt = new Date(Date.now() - 1).toISOString();
  ready.resumeState.lastRequestAt = Date.now() - 1000;
  const resumed = await scrapeMicrosoft({delayMs:10,resume:ready,fetchImpl:async () => {
    calls++;
    return new Response('', {status:429,headers:{'Retry-After':'60'}});
  }});
  assert.equal(calls, 2);
  assert.equal(resumed.resumeState.requestDelayMs, 40);
  assert.ok(continuationForMicrosoft(resumed));
});

test('Microsoft checkpoints reject invalid persisted pacing metadata before making requests', async () => {
  const saved = await scrapeMicrosoft({delayMs:0,fetchImpl:async () => new Response('',{status:429,headers:{'Retry-After':'60'}})});
  saved.continuation.retryAt = new Date(Date.now() - 1).toISOString();
  for (const metadata of [
    {requestDelayMs:-1}, {requestDelayMs:60001}, {requestDelayMs:'10000'}, {requestDelayMs:Infinity},
    {lastRequestAt:-1}, {lastRequestAt:'yesterday'}, {lastRequestAt:Infinity},
  ]) {
    const invalid = {...saved,resumeState:{...saved.resumeState,...metadata}};
    assert.equal(continuationForMicrosoft(invalid), null, JSON.stringify(metadata));
    await assert.rejects(scrapeMicrosoft({delayMs:0,resume:invalid,fetchImpl:async () => assert.fail('Invalid checkpoint must not request jobs')}), /cannot resume|checkpoint|current source/i);
  }
});
