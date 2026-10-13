import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalNvidiaUrl, buildNvidiaSearchUrl, parseNvidiaSearch, isNvidiaSoftwareRole, normalizeNvidiaJob, scrapeNvidia, continuationForNvidia } from '../lib/nvidia.js';
const role = (id, name='Software Engineer', locations=['US, CA, Santa Clara']) => ({id,name,locations,standardizedLocations:locations[0].startsWith('US')?['Santa Clara, CA, US']:['Toronto, ON, CA'],department:'Engineer, Sys SW',postedTs:1790899200});
const response = positions => new Response(JSON.stringify({status:200,data:{positions,count:2}}), {headers:{'Content-Type':'application/json'}});
test('NVIDIA URL forces United States and rejects non-US or off-site sources',()=>{
  assert.equal(new URL(canonicalNvidiaUrl('https://jobs.nvidia.com/careers')).searchParams.get('location'),'United States');
  for(const value of ['https://jobs.nvidia.com/careers?location=India','https://jobs.nvidia.com/careers?country=Canada','http://jobs.nvidia.com/careers','https://jobs.nvidia.com.evil.example/careers','https://u@jobs.nvidia.com/careers'])assert.throws(()=>canonicalNvidiaUrl(value));
  assert.equal(new URL(buildNvidiaSearchUrl(canonicalNvidiaUrl(),20)).searchParams.get('start'),'20');
});
test('NVIDIA filters country codes and engineering titles; mixed-country display is US-only',()=>{
  assert.equal(isNvidiaSoftwareRole(role(1)),true);
  assert.equal(isNvidiaSoftwareRole(role(2,'Software Engineer',['CA, Toronto'])),false);
  for(const title of ['Hardware Engineer','Senior Formal Verification Engineer','Software Engineering Manager','Data Scientist'])assert.equal(isNvidiaSoftwareRole(role(3,title)),false,title);
  const mixed=role(4,'Software Engineer',['US, CA, Santa Clara','Canada, Toronto']);
  assert.equal(normalizeNvidiaJob(mixed,canonicalNvidiaUrl()).location,'Santa Clara, CA, United States');
});
test('NVIDIA normalization extracts stated USD ranges and requirement years',()=>{
  const job=normalizeNvidiaJob({...role(5),jobDescription:'<p>What we need to see:</p><p>8+ years in a similar role.</p><p>Ways to stand out:</p><p>20 years preferred</p>The base salary range is 184,000 USD - 287,500 USD for Level 4, and 224,000 USD - 356,500 USD for Level 5. You are eligible for benefits.'},canonicalNvidiaUrl());
  assert.equal(job.company,'NVIDIA');assert.equal(job.yearsExperience,8);assert.equal(job.salaryMin,184000);assert.equal(job.salaryMax,356500);assert.equal(job.salaryCurrency,'USD');
  assert.equal(job.salaryPeriod,'year');
  assert.equal(new URL(job.url).hostname,'jobs.nvidia.com');
  assert.throws(()=>parseNvidiaSearch({status:200,data:{count:2}}));
});
test('NVIDIA pagination saves and resumes the raw offset, including rejected foreign jobs',async()=>{
  const source=canonicalNvidiaUrl();
  const first=await scrapeNvidia({url:source,pages:1,maxDetails:0,delayMs:0,fetchImpl:async()=>response([role(1)])});
  assert.equal(first.continuation.offset,1);assert.equal(first.jobs.length,1);assert.equal(first.stoppedEarly.includes('Page limit'),true);
  const resumed=await scrapeNvidia({url:source,pages:5,maxDetails:0,delayMs:0,resume:first,fetchImpl:async url=>{
    assert.equal(new URL(url).searchParams.get('start'),'1');return response([role(2,'Software Engineer',['CA, Toronto'])]);
  }});
  assert.equal(resumed.listingCount,2);assert.equal(resumed.jobs.length,1);assert.equal(resumed.continuation,null);assert.equal(resumed.totalPages,2);
  assert.equal(continuationForNvidia({...first,effectiveUrl:'https://jobs.nvidia.com/careers?location=Canada'}),null);
});
test('NVIDIA enrichment validates role identity and does not erase search jobs on missing details',async()=>{
  const result=await scrapeNvidia({delayMs:0,maxDetails:1,fetchImpl:async url=>url.includes('position_details')?new Response('',{status:404}):new Response(JSON.stringify({status:200,data:{positions:[role(123)],count:1}}))});
  assert.equal(result.jobs.length,1);assert.equal(result.detailsCompleted,1);assert.equal(result.detailsFetched,0);assert.equal(result.errors[0].status,404);
});
test('NVIDIA denied responses stop and rate limits preserve cooldown before another request',async()=>{
  const denied=await scrapeNvidia({fetchImpl:async()=>new Response('',{status:403})});
  assert.equal(denied.continuation,null);
  const limited=await scrapeNvidia({fetchImpl:async()=>new Response('',{status:429,headers:{'Retry-After':'60'}})});
  assert.ok(limited.continuation.retryAt);
  await assert.rejects(scrapeNvidia({resume:limited,fetchImpl:async()=>{throw new Error('Should not request');}}),/cooldown/);
});

test('NVIDIA timed-out search resumes at the unread raw offset',async()=>{
  const pending=(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  let calls=0;
  const first=await scrapeNvidia({delayMs:0,maxDetails:0,timeBudgetMs:20,fetchImpl:async (...args)=>++calls===1?response([role(111)]):pending(...args)});
  assert.equal(first.pagesFetched,1);assert.equal(first.listingCount,1);assert.equal(first.continuation.phase,'search');
  const resumed=await scrapeNvidia({delayMs:0,maxDetails:0,resume:first,fetchImpl:async url=>{assert.equal(new URL(url).searchParams.get('start'),'1');return response([role(222)]);}});
  assert.equal(resumed.jobs.length,2);assert.equal(resumed.errors.length,0);assert.equal(resumed.continuation,null);
});

test('NVIDIA retries an initially empty page when that response advertises available listings',async()=>{
  let calls=0;
  const result=await scrapeNvidia({delayMs:0,maxDetails:0,pages:1,fetchImpl:async()=>response(++calls===1?[]:[role(111)])});
  assert.equal(calls,2);assert.equal(result.jobs.length,1);assert.equal(result.listingCount,1);assert.equal(result.pagesFetched,1);
  assert.match(result.stoppedEarly,/Page limit/);
});

test('NVIDIA detail-only continuation does not re-read search pages',async()=>{
  const first=await scrapeNvidia({delayMs:0,maxDetails:1,timeBudgetMs:20,fetchImpl:async (url,{signal})=>{
    if(url.includes('position_details'))return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return new Response(JSON.stringify({status:200,data:{positions:[role(123)],count:1}}));
  }});
  assert.equal(first.continuation.phase,'details');assert.equal(first.stoppedEarly,null);
  const resumed=await scrapeNvidia({delayMs:0,maxDetails:1,resume:first,fetchImpl:async url=>{
    assert.ok(url.includes('position_details'));return new Response(JSON.stringify({status:200,data:role(123)}));
  }});
  assert.equal(resumed.detailsFetched,1);assert.equal(resumed.pagesFetched,1);assert.equal(resumed.errors.length,0);assert.equal(resumed.continuation,null);
});

const describedRole = id => ({...role(id),jobDescription:'<p>What we need to see:</p><p>6+ years of software development experience.</p><p>Ways to stand out:</p><p>10 years preferred.</p><p>The base salary range is 160,000 USD - 260,000 USD. You are eligible for equity and benefits.</p>'});
const searchResponse = (positions,count) => new Response(JSON.stringify({status:200,data:{positions,count}}));
const detailResponse = id => new Response(JSON.stringify({status:200,data:describedRole(id)}));

test('NVIDIA default enrichment covers more than 100 roles before later search pages',async()=>{
  const roles=Array.from({length:111},(_,index)=>role(index+1));
  const requests=[];
  const result=await scrapeNvidia({delayMs:0,fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname.endsWith('position_details')) {
      const id=Number(url.searchParams.get('position_id'));requests.push(`detail:${id}`);return detailResponse(id);
    }
    const offset=Number(url.searchParams.get('start'));requests.push(`search:${offset}`);return searchResponse(roles.slice(offset,offset+10),roles.length);
  }});
  assert.equal(result.jobs.length,111);
  assert.equal(result.detailsFetched,111);
  assert.equal(result.detailsRemaining,0);
  assert.equal(result.continuation,null);
  assert.equal(result.enrichmentStoppedEarly,null);
  assert.equal(result.jobs.every(job=>job.detailsRead&&job.yearsExperience===6&&job.salaryMin===160000&&job.salaryMax===260000),true);
  assert.equal(requests.filter(value=>value.startsWith('detail:')).length,111);
  assert.ok(requests.indexOf('detail:1')<requests.indexOf('search:100'),'collected roles should be enriched before the next ten-page batch');
});

test('NVIDIA enriches jobs in a page-limited partial fetch while preserving unread search offset',async()=>{
  const requests=[];
  const result=await scrapeNvidia({pages:1,delayMs:0,fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname.endsWith('position_details')) {
      const id=Number(url.searchParams.get('position_id'));requests.push(`detail:${id}`);return detailResponse(id);
    }
    requests.push('search');return searchResponse([role(11),role(12)],4);
  }});
  assert.deepEqual(requests,['search','detail:11','detail:12']);
  assert.equal(result.detailsFetched,2);
  assert.equal(result.jobs.every(job=>job.yearsExperience===6&&job.salaryCurrency==='USD'),true);
  assert.match(result.stoppedEarly,/Page limit/);
  assert.equal(result.continuation.phase,'search');
  assert.equal(result.continuation.offset,2);
  assert.equal(result.continuation.nextPage,2);
  assert.ok(continuationForNvidia(result));
});

test('NVIDIA upgrades an old enrichment cap using saved jobs before continuing search',async()=>{
  const roles=Array.from({length:112},(_,index)=>role(index+1));
  const first=await scrapeNvidia({pages:11,maxDetails:100,delayMs:0,fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname.endsWith('position_details'))return detailResponse(Number(url.searchParams.get('position_id')));
    const offset=Number(url.searchParams.get('start'));return searchResponse(roles.slice(offset,offset+10),roles.length);
  }});
  assert.equal(first.jobs.length,110);
  assert.equal(first.detailsFetched,100);
  assert.equal(first.resumeState.detailRoles.length,100);
  assert.equal(first.continuation.offset,110);
  const requests=[];
  const resumed=await scrapeNvidia({resume:first,delayMs:0,fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname.endsWith('position_details')) {
      const id=Number(url.searchParams.get('position_id'));requests.push(`detail:${id}`);return detailResponse(id);
    }
    const offset=Number(url.searchParams.get('start'));requests.push(`search:${offset}`);assert.equal(offset,110);return searchResponse(roles.slice(offset),roles.length);
  }});
  assert.equal(requests[0],'detail:101');
  assert.ok(requests.indexOf('detail:110')<requests.indexOf('search:110'));
  assert.equal(requests.filter(value=>value.startsWith('detail:')).length,12,'previously enriched roles must not be fetched twice');
  assert.equal(resumed.jobs.length,112);
  assert.equal(resumed.detailsFetched,112);
  assert.equal(resumed.jobs.every(job=>job.detailsRead&&job.yearsExperience===6&&job.salaryMin===160000),true);
  assert.equal(resumed.continuation,null);
  await assert.rejects(scrapeNvidia({resume:first,maxDetails:99,delayMs:0,fetchImpl:async()=>{throw new Error('Should not request');}}),/cannot resume|current source|limits/i);
});

test('NVIDIA detail rate limits before listing completion retain the search cursor and stop requests',async()=>{
  const roles=Array.from({length:110},(_,index)=>role(index+1));
  let detailCalls=0,searchCalls=0;
  const result=await scrapeNvidia({delayMs:0,fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname.endsWith('position_details')) {
      detailCalls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});
    }
    searchCalls++;const offset=Number(url.searchParams.get('start'));return searchResponse(roles.slice(offset,offset+10),roles.length);
  }});
  assert.equal(searchCalls,10);
  assert.equal(detailCalls,1);
  assert.equal(result.jobs.length,100);
  assert.equal(result.continuation.phase,'search');
  assert.equal(result.continuation.offset,100);
  assert.equal(result.continuation.nextPage,11);
  assert.ok(Date.parse(result.continuation.retryAt)>Date.now());
  assert.ok(continuationForNvidia(result));
  await assert.rejects(scrapeNvidia({resume:result,fetchImpl:async()=>{throw new Error('Should not request during cooldown');}}),/cooldown/);
});

test('NVIDIA detail timeout in a partial search resumes saved details before the unread page',async()=>{
  const first=await scrapeNvidia({pages:1,maxDetails:2,delayMs:0,timeBudgetMs:100,fetchImpl:async(value,{signal})=>{
    if(new URL(value).pathname.endsWith('position_details'))return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return searchResponse([role(51),role(52)],4);
  }});
  assert.equal(first.continuation.phase,'search');
  assert.equal(first.continuation.offset,2);
  assert.equal(first.continuation.nextPage,2);
  assert.equal(first.detailsFetched,0);
  assert.ok(continuationForNvidia(first));
  const requests=[];
  const resumed=await scrapeNvidia({resume:first,maxDetails:2,delayMs:0,fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname.endsWith('position_details')) {
      const id=Number(url.searchParams.get('position_id'));requests.push(`detail:${id}`);return detailResponse(id);
    }
    const offset=Number(url.searchParams.get('start'));requests.push(`search:${offset}`);assert.equal(offset,2);return searchResponse([role(53,'Hardware Engineer'),role(54,'Hardware Engineer')],4);
  }});
  assert.deepEqual(requests,['detail:51','detail:52','search:2']);
  assert.equal(resumed.detailsFetched,2);
  assert.equal(resumed.jobs.every(job=>job.yearsExperience===6&&job.salaryMin===160000),true);
  assert.equal(resumed.errors.length,0);
  assert.equal(resumed.continuation,null);
});

test('NVIDIA accepts heading and salary punctuation variants without unrelated amounts or preferred years',()=>{
  for(const salary of ['$160,000 – $260,000','160,000 USD — 260,000 USD','USD 160,000 - USD 260,000']) {
    const job=normalizeNvidiaJob({...role(999),jobDescription:`<p>Our team has 25 years of history.</p><h3>What we need to see</h3><p>6–8 years of software engineering experience.</p><h3>Ways to stand out</h3><p>2 years preferred with a framework.</p><p>The base salary range is ${salary}. You are eligible for a $20,000 sign-on bonus.</p>`},canonicalNvidiaUrl());
    assert.equal(job.yearsExperience,6,salary);
    assert.equal(job.salaryMin,160000,salary);
    assert.equal(job.salaryMax,260000,salary);
    assert.equal(job.salaryCurrency,'USD',salary);
  }
  const unknown=normalizeNvidiaJob({...role(999),jobDescription:'What we need to see: Strong C++ skills. Ways to stand out: 2 years preferred. A $20,000 signing bonus and $40,000 equity are available.'},canonicalNvidiaUrl());
  assert.equal(unknown.yearsExperience,null);
  assert.equal(unknown.salaryMin,null);
  assert.equal(unknown.salaryMax,null);
});

test('NVIDIA experience extracts live requirement phrasing only when a year unit is stated',()=>{
  const requirements=[
    ['What we need to see: 12+ overall years of experience in software development.',12],
    ['What we need to see: 8+ yrs of relevant experience.',8],
    ['What we need to see: 5 or more years of software engineering experience.',5],
    ["What we need to see: Bachelor's with 5 or more years of experience or Master's plus 3 or more years of experience. 2 or more years with CUDA.",2],
    ['What you’ll need: 8+ years of software engineering experience.',8],
    ['<h3>What you&rsquo;ll need:</h3><p>8+ years of software engineering experience.</p>',8],
    ['What we need to see: 8+ software engineering experience.',null],
    ['What we need to see: 8+ proven experience with distributed systems.',null],
    ['What we need to see: New graduate with a degree in computer science or equivalent experience.',null],
  ];
  for(const [requirement,expected] of requirements) {
    const job=normalizeNvidiaJob({...role(777),jobDescription:`Our team has 25 years of history. ${requirement} Ways to stand out: 1 year preferred with visualization tools.`},canonicalNvidiaUrl());
    assert.equal(job.yearsExperience,expected,requirement);
  }
});

test('NVIDIA extracts stated hourly internship pay without treating it as annual salary or experience',()=>{
  for(const [min,max] of [[20,71],[30,94]]) {
    const job=normalizeNvidiaJob({...role(888,'Software Engineering Intern'),jobDescription:`<p>What we need to see:</p><p>Currently pursuing a BS, MS, or PhD in computer science.</p><p>Ways to stand out:</p><p>1 year preferred with CUDA.</p><p>The hourly rate for our interns is ${min} USD - ${max} USD. You are eligible for a $5,000 bonus and $10,000 equity.</p>`},canonicalNvidiaUrl());
    assert.equal(job.salaryMin,min);
    assert.equal(job.salaryMax,max);
    assert.equal(job.salaryCurrency,'USD');
    assert.equal(job.salaryPeriod,'hour');
    assert.equal(job.yearsExperience,null);
  }
});

test('NVIDIA accepts the live missing-to requirement heading and keeps pay separate from benefits',()=>{
  const job=normalizeNvidiaJob({...role(889,'Site Reliability Engineer'),jobDescription:"What we need see: BS with 8+ years of experience, MS with 5+ years of experience, or PhD with 3+ years of experience. Ways to stand out: 2 years with Kubernetes preferred. The base salary range is 160,000 USD - 260,000 USD. You are eligible for 10,000 USD - 20,000 USD equity awards and a 5,000 USD bonus."},canonicalNvidiaUrl());
  assert.equal(job.yearsExperience,3);
  assert.equal(job.salaryMin,160000);
  assert.equal(job.salaryMax,260000);
  assert.equal(job.salaryCurrency,'USD');
  assert.equal(job.salaryPeriod,'year');
  const unknown=normalizeNvidiaJob({...role(890,'Software Engineering Intern'),jobDescription:'What we need to see: Currently pursuing a degree. Equity awards of 10,000 USD - 20,000 USD and a 5,000 USD bonus are available.'},canonicalNvidiaUrl());
  assert.equal(unknown.salaryMin,null);
  assert.equal(unknown.salaryMax,null);
  assert.equal(unknown.salaryCurrency,null);
  assert.equal(unknown.salaryPeriod,null);
  assert.equal(unknown.yearsExperience,null);
});
