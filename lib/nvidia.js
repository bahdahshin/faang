import { isSoftwareEngineeringRole, normalizeAppleJob } from './apple.js';
import { continuationForEightfold, scrapeEightfold } from './eightfold.js';

export const NVIDIA_US_SOURCE_URL = 'https://jobs.nvidia.com/careers?location=United%20States';
export function canonicalNvidiaUrl(value = NVIDIA_US_SOURCE_URL) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'jobs.nvidia.com' || url.port || url.username || url.password || !/^\/careers\/?$/.test(url.pathname)) throw new Error('Use https://jobs.nvidia.com/careers.');
  const location = url.searchParams.get('location');
  if (location && !/^(?:United States(?: of America)?|USA|US)$/i.test(location)) throw new Error('NVIDIA sources must use United States locations.');
  if (['country', 'countryCode'].some(key => url.searchParams.has(key) && !/^(?:United States|USA|US)$/i.test(url.searchParams.get(key)))) throw new Error('NVIDIA sources must use United States locations.');
  url.pathname = '/careers'; url.hash = '';
  url.searchParams.set('location', 'United States');
  url.searchParams.delete('start'); url.searchParams.delete('page');
  url.searchParams.sort();
  return url.href;
}
export function buildNvidiaSearchUrl(value, start = 0) {
  const source = new URL(canonicalNvidiaUrl(value));
  const url = new URL('https://jobs.nvidia.com/api/pcsx/search');
  url.searchParams.set('domain', 'nvidia.com');
  url.searchParams.set('query', source.searchParams.get('query') || '');
  url.searchParams.set('location', 'United States');
  url.searchParams.set('start', String(start));
  return url.href;
}
const clean = value => String(value || '').replace(/<[^>]*>/g, ' ')
  .replace(/&#(x[\da-f]+|\d+);/ig, (_match, code) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  })
  .replace(/&(nbsp|amp|ndash|mdash|rsquo|lsquo|quot);/ig, (_match, entity) => ({nbsp:' ',amp:'&',ndash:'–',mdash:'—',rsquo:"'",lsquo:"'",quot:'"'})[entity.toLowerCase()])
  .replace(/\s+/g, ' ').trim();
const idOf = role => String(role?.id ?? '');
export function usLocations(role) {
  const raw = (role.locations || []).filter(value => typeof value === 'string' && /^(?:US(?:,|$)|Remote\s*-\s*US$)|United States(?: of America)?$/i.test(value));
  const standardized = (role.standardizedLocations || []).filter(value => typeof value === 'string' && /(?:^|,\s*)(?:US|USA|United States)$/i.test(value));
  return [...new Set((raw.length ? raw : standardized).map(value => {
    if (/^Remote\s*-\s*US$/i.test(value)) return 'Remote, United States';
    if (/^US(?:,|$)/i.test(value)) return [...value.split(',').slice(1).map(x => x.trim()).reverse(), 'United States'].filter(Boolean).join(', ');
    return value.replace(/(?:US|USA)$/i, 'United States');
  }))];
}
export function isNvidiaSoftwareRole(role) {
  return usLocations(role).length > 0 && isSoftwareEngineeringRole({ postingTitle: role.name, team: { teamName: role.department, teamCode: /(?:\bSW\b|software)/i.test(role.department || '') ? 'SFTWR' : '' } });
}
export function normalizeNvidiaJob(role, sourceUrl) {
  const text = clean(role.jobDescription);
  const requirements = text.split(/what (?:we need (?:to )?see|you(?:['’]ll| will) need)\s*:?/i)[1]?.split(/ways to stand out|preferred qualifications|your base salary|the base salary|hourly rate/i)[0] || '';
  const years = [...requirements.matchAll(/\b(\d{1,2})(?:\s*(?:[-–—]|to)\s*\d{1,2})?\s*\+?\s*(?:(?:or more|overall)\s+)?(?:years?|yrs?)\b/ig)].map(m => Number(m[1])).filter(n => n <= 40);
  const salaryText = text.split(/base salary range\b/i)[1]?.split(/eligible|applications|benefits|equity|bonus/i)[0]?.slice(0, 600) || '';
  const salaryPattern = /(?:(USD|\$)\s*)?([\d,]+)(?:\s*(USD))?\s*(?:[-–—]|to)\s*(?:(USD|\$)\s*)?([\d,]+)(?:\s*(USD))?/ig;
  const payRanges = (payText, floor, ceiling) => [...payText.matchAll(salaryPattern)]
    .filter(m => m[1] || m[3] || m[4] || m[6])
    .map(m => [Number(m[2].replaceAll(',', '')), Number(m[5].replaceAll(',', ''))])
    .filter(([a,b]) => a >= floor && b >= a && b <= ceiling);
  const annualRanges = payRanges(salaryText, 10000, 2000000);
  const hourlyText = text.split(/hourly (?:rate|pay)(?: range)?\b/i)[1]?.split(/eligible|applications|benefits|equity|bonus/i)[0]?.slice(0, 600) || '';
  const ranges = annualRanges.length ? annualRanges : payRanges(hourlyText, 1, 1000);
  const locations = usLocations(role);
  const job = normalizeAppleJob({ positionId: idOf(role), postingTitle: role.name, description: text,
    postDateInGMT: Number.isFinite(role.postedTs) ? new Date(role.postedTs * 1000).toISOString() : null,
    locations: locations.map(name => ({ name, countryName: 'United States' })) }, sourceUrl);
  return { ...job, id: idOf(role), company: 'NVIDIA', source: 'NVIDIA', provider: 'nvidia',
    location: locations.join(' · ') || null, description: text || null,
    yearsExperience: years.length ? Math.min(...years) : null,
    salaryMin: ranges.length ? Math.min(...ranges.map(r => r[0])) : null,
    salaryMax: ranges.length ? Math.max(...ranges.map(r => r[1])) : null,
    salaryCurrency: ranges.length ? 'USD' : null,
    salaryPeriod: ranges.length ? annualRanges.length ? 'year' : 'hour' : null,
    url: `https://jobs.nvidia.com/careers/job/${encodeURIComponent(idOf(role))}` };
}
export function parseNvidiaSearch(payload) {
  const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (body?.status !== 200 || !Array.isArray(body.data?.positions) || !Number.isInteger(body.data.count) || body.data.count < 0) throw new Error('NVIDIA returned an unexpected search response.');
  return { positions: body.data.positions, totalResults: body.data.count };
}
const nvidiaAdapter = {
  provider: 'nvidia', label: 'NVIDIA', domain: 'nvidia.com', host: 'jobs.nvidia.com', sourceUrl: NVIDIA_US_SOURCE_URL,
  canonicalUrl: canonicalNvidiaUrl, buildSearchUrl: buildNvidiaSearchUrl, parseSearch: parseNvidiaSearch,
  isSoftwareRole: isNvidiaSoftwareRole, normalizeJob: normalizeNvidiaJob,
};
export const continuationForNvidia = snapshot => continuationForEightfold(nvidiaAdapter, snapshot);
export const scrapeNvidia = options => scrapeEightfold(nvidiaAdapter, options);
