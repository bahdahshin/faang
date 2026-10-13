import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { continuationFor } from '../lib/providers.js';
import { collectEnabledSources } from '../lib/collect.js';
const store=createStore({dir:process.env.DATA_DIR || fileURLToPath(new URL('../data',import.meta.url))});
const arg=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const pages=Number(arg('pages') || process.env.APPLE_PAGES || 500);
if(!Number.isInteger(pages)||pages<1||pages>500)throw new Error('--pages must be 1-500.');
const resumeId=arg('resume');
const resume=resumeId?await store.load(resumeId):null;
if(resumeId&&!resume)throw new Error('Saved fetch not found.');
const sourceId=arg('source') || resume?.sourceId || 'all';
const catalog=await store.sources();
const sources=sourceId==='all'?catalog.filter(source=>source.enabled):catalog.filter(source=>source.id===sourceId&&source.enabled);
if(!sources.length)throw new Error('Enable a source before fetching.');
if(resume&&(sources.length!==1||resume.sourceId!==sources[0].id||resume.sourceUrl!==sources[0].url||!continuationFor(resume)))throw new Error('This saved checkpoint cannot resume with the selected source.');
try {
  const result=await collectEnabledSources({store,sources,pages,resumeId,timeBudgetMs:Number(process.env.APPLE_TIME_BUDGET_MS || 240000),onEvent:event=>{
    if(event.type==='progress')console.log(event.message);
    if(event.type==='source_done')console.log(`Saved ${event.fetch.jobCount} jobs from ${event.sourceName}.`);
    if(event.type==='source_error')console.error(`${event.sourceName}: ${event.error}`);
  }});
  console.log(`Combined dashboard: ${result.jobCount} jobs from ${result.sourceCoverage.length} enabled sources${result.partial?' (some sources incomplete)':''}.`);
  if(result.partial)process.exitCode=1;
}catch(error){console.error(error.message);process.exitCode=1;}
