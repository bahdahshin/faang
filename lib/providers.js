import { scrapeApple, continuationFor as appleContinuation } from './apple.js';
import { scrapeNvidia, continuationForNvidia, canonicalNvidiaUrl } from './nvidia.js';
import { scrapeMicrosoft, continuationForMicrosoft, canonicalMicrosoftUrl } from './microsoft.js';
const adapters = {
  apple: { scrape: scrapeApple, continuation: appleContinuation },
  nvidia: { scrape: scrapeNvidia, continuation: continuationForNvidia },
  microsoft: { scrape: scrapeMicrosoft, continuation: continuationForMicrosoft },
};
export const supportedProviders = Object.keys(adapters);
export function sourceSearchUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Use a supported HTTPS careers URL.');
  if (url.hostname === 'jobs.apple.com' && url.pathname === '/en-us/search') { url.hash = ''; return { provider: 'apple', url: url.href }; }
  if (url.hostname === 'jobs.nvidia.com') return { provider: 'nvidia', url: canonicalNvidiaUrl(value) };
  if (url.hostname === 'apply.careers.microsoft.com') return { provider: 'microsoft', url: canonicalMicrosoftUrl(value) };
  throw new Error('Supported sources are https://jobs.apple.com/en-us/search, https://jobs.nvidia.com/careers, and https://apply.careers.microsoft.com/careers. NVIDIA and Microsoft use US locations only.');
}
export function providerForUrl(url) { return sourceSearchUrl(url).provider; }
export function continuationFor(snapshot) {
  try {
    const provider = providerForUrl(snapshot.sourceUrl);
    if (snapshot.provider && snapshot.provider !== provider) return null;
    return adapters[provider].continuation(snapshot);
  } catch { return null; }
}
export function scrapeSource(options) { return adapters[providerForUrl(options.url)].scrape(options); }
