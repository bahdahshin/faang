import { isSoftwareEngineeringRole, normalizeAppleJob } from './apple.js';
import { continuationForEightfold, scrapeEightfold } from './eightfold.js';

export const MICROSOFT_US_SOURCE_URL = 'https://apply.careers.microsoft.com/careers?location=United+States';
const usCountry = value => /^(?:United States(?: of America)?|USA|US)$/i.test(value.trim());
export function canonicalMicrosoftUrl(value = MICROSOFT_US_SOURCE_URL) {
  const input = new URL(value);
  if (input.protocol !== 'https:' || input.hostname !== 'apply.careers.microsoft.com' || input.port || input.username || input.password || !/^\/careers\/?$/.test(input.pathname)) throw new Error('Use https://apply.careers.microsoft.com/careers.');
  for (const key of ['location', 'country', 'countryCode', 'country_code']) {
    if (input.searchParams.getAll(key).some(value => value && !usCountry(value))) throw new Error('Microsoft sources must use United States locations.');
  }
  // Build one explicit country query. URL pagination and arbitrary location
  // options cannot override the US filter used by the actual search feed.
  const url = new URL('https://apply.careers.microsoft.com/careers');
  url.searchParams.set('location', 'United States');
  if (input.searchParams.get('query')) url.searchParams.set('query', input.searchParams.get('query'));
  url.searchParams.sort();
  return url.href;
}
export function buildMicrosoftSearchUrl(value, start = 0) {
  const source = new URL(canonicalMicrosoftUrl(value));
  const url = new URL('https://apply.careers.microsoft.com/api/pcsx/search');
  url.searchParams.set('domain', 'microsoft.com');
  url.searchParams.set('query', source.searchParams.get('query') || '');
  url.searchParams.set('location', 'United States');
  url.searchParams.set('start', String(start));
  return url.href;
}

const clean = value => String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/ig, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/ig, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&#(x[\da-f]+|\d+);/ig, (_match, code) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  })
  .replace(/&(nbsp|amp|ndash|mdash|rsquo|lsquo|quot|apos);/ig, (_match, entity) => ({nbsp:' ',amp:'&',ndash:'–',mdash:'—',rsquo:"'",lsquo:"'",quot:'"',apos:"'"})[entity.toLowerCase()])
  .replace(/\s+/g, ' ').trim();

/** Check explicit countries, including the country's position in Microsoft's
 * display location. A city name alone is never evidence that a job is in US. */
export function microsoftUsLocations(role) {
  const display = (Array.isArray(role.locations) ? role.locations : [role.location]).filter(value => typeof value === 'string')
    .filter(value => /^(?:United States(?: of America)?|US|USA)(?:\s*,|$)|(?:^|,\s*)(?:United States(?: of America)?|US|USA)$|^Remote\s*-\s*US$/i.test(value.trim()));
  const standardized = (Array.isArray(role.standardizedLocations) ? role.standardizedLocations : [])
    .filter(value => typeof value === 'string' && /(?:^|,\s*)(?:US|USA|United States)$/i.test(value.trim()));
  return [...new Set((display.length ? display : standardized).map(value => {
    if (/^Remote\s*-\s*US$/i.test(value)) return 'Remote, United States';
    const parts = value.split(',').map(part => part.trim());
    if (usCountry(parts[0])) {
      return [...parts.slice(1).filter(part => part && !/^Multiple Locations$/i.test(part)).reverse(), 'United States'].join(', ');
    }
    return [...parts.slice(0, -1), 'United States'].join(', ');
  }))];
}
export function isMicrosoftSoftwareRole(role) {
  const roleTypes = Array.isArray(role.efcustomTextRoletype) ? role.efcustomTextRoletype : [role.efcustomTextRoletype];
  if (!microsoftUsLocations(role).length || roleTypes.some(value => /people manager/i.test(value || '')) || /\bsolutions?\s+engineer\b|\bdata cent(?:er|re)\b/i.test(role.name || '')) return false;
  return isSoftwareEngineeringRole({ postingTitle: role.name, team: {
    teamName: role.department,
    teamCode: /software engineering/i.test(role.department || '') ? 'SFTWR' : '',
  } });
}
function requiredYears(text) {
  // Preferred education alternatives and periodic background checks must not
  // lower the published minimum professional experience requirement.
  const start = /(?:required|minimum|basic) qualifications\s*:?(?:\s|$)/i.exec(text);
  const generic = /(?<!preferred )\bqualifications\s*:?/i.exec(text);
  const qualifications = start ? text.slice(start.index + start[0].length)
    : generic ? text.slice(generic.index + generic[0].length) : '';
  const required = qualifications.split(/preferred qualifications|other requirements|additional (?:or preferred )?qualifications|compensation|(?:typical )?base (?:pay|salary) range/i)[0];
  const matches = [...required.matchAll(/\b(\d{1,2})(?:\s*(?:[-–—]|to)\s*\d{1,2})?\s*\+?\s*(?:(?:or more|overall)\s+)?(?:years?|yrs?)\b(?=([^.;]{0,140}))/ig)]
    .filter(match => !/preferred|background check|thereafter|anniversary/i.test(match[2]))
    .map(match => Number(match[1])).filter(years => years <= 40);
  return matches.length ? Math.min(...matches) : null;
}
function salaryRanges(text) {
  text = text.replace(/\bU\.S\.(?:A\.)?/ig, 'US');
  const ranges = [];
  // Start each match at a stated base-pay range. Bonus/stock amounts in later
  // sentences cannot be mistaken for annual or hourly compensation.
  const pattern = /(?:base (?:pay|salary)(?: range)?|salary range|hourly (?:rate|pay)(?: range)?)(?:(?!base (?:pay|salary)|[.;]).){0,200}?((?:USD\s*)?(?:US\s*)?\$\s*[\d,]+(?:\.\d+)?\s*(?:[-–—]|to|and)\s*(?:USD\s*)?(?:US\s*)?\$\s*[\d,]+(?:\.\d+)?)([^.;]{0,55})/ig;
  for (const match of text.matchAll(pattern)) {
    if (/\b(?:CAD|AUD|NZD|SGD|HKD|Canadian|Australian)\b|[CA]\s*\$/i.test(match[0])) continue;
    const amounts = [...match[1].matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)].map(value => Number(value[1].replaceAll(',', '')));
    const hourly = /hourly|per hour|an hour|\/\s*hr\b/i.test(match[0]);
    const [min, max] = amounts;
    if (hourly ? min >= 1 && max >= min && max <= 1000 : min >= 10000 && max >= min && max <= 2000000) ranges.push({min,max,period:hourly?'hour':'year'});
  }
  const annual = ranges.filter(range => range.period === 'year');
  return annual.length ? annual : ranges.filter(range => range.period === 'hour');
}
export function normalizeMicrosoftJob(role, sourceUrl = MICROSOFT_US_SOURCE_URL) {
  const text = clean(role.jobDescription);
  const locations = microsoftUsLocations(role);
  const ranges = salaryRanges(text);
  const job = normalizeAppleJob({ positionId: String(role.id), postingTitle: role.name, description: text,
    postDateInGMT: Number.isFinite(role.postedTs) ? new Date(role.postedTs * 1000).toISOString() : null,
    locations: locations.map(name => ({ name, countryName: 'United States' })) }, sourceUrl);
  return { ...job, id: String(role.id), company: 'Microsoft', source: 'Microsoft', provider: 'microsoft',
    location: locations.join(' · ') || null, description: text || null,
    yearsExperience: requiredYears(text),
    salaryMin: ranges.length ? Math.min(...ranges.map(range => range.min)) : null,
    salaryMax: ranges.length ? Math.max(...ranges.map(range => range.max)) : null,
    salaryCurrency: ranges.length ? 'USD' : null, salaryPeriod: ranges[0]?.period || null,
    url: `https://apply.careers.microsoft.com/careers/job/${encodeURIComponent(String(role.id))}` };
}
export function parseMicrosoftSearch(payload) {
  const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (body?.status !== 200 || !Array.isArray(body.data?.positions) || !Number.isInteger(body.data.count) || body.data.count < 0) throw new Error('Microsoft returned an unexpected search response.');
  return { positions: body.data.positions, totalResults: body.data.count };
}
const adapter = { provider: 'microsoft', label: 'Microsoft', domain: 'microsoft.com', host: 'apply.careers.microsoft.com', delayMs: 10000, listingsFirst: true,
  sourceUrl: MICROSOFT_US_SOURCE_URL, canonicalUrl: canonicalMicrosoftUrl, buildSearchUrl: buildMicrosoftSearchUrl,
  parseSearch: parseMicrosoftSearch, isSoftwareRole: isMicrosoftSoftwareRole, normalizeJob: normalizeMicrosoftJob };
export const continuationForMicrosoft = snapshot => continuationForEightfold(adapter, snapshot);
export const scrapeMicrosoft = options => scrapeEightfold(adapter, options);
