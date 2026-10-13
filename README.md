# Software Engineer Job Market

A runnable web app based on the dashboard UI at [job.bahdahshin.com](https://job.bahdahshin.com/) and the public [bahdahshin/swe-job](https://github.com/bahdahshin/swe-job) project. It collects software engineering jobs directly from Apple Careers, NVIDIA Careers, and Microsoft Careers.

## Run locally

Requires Node.js 22.9 or newer. There are no third-party runtime dependencies.

```sh
npm install
npm start
```

Open **http://localhost:3000** and click **Fetch source** to collect postings from every enabled source. The dashboard combines their latest saved results and supports company and job filters. Progress streams into the page while the fetch runs.

To fetch from the command line:

```sh
npm run fetch
npm run fetch -- --pages=5 --source=apple
npm run fetch -- --resume=<saved-fetch-id>
```

Use `npm run dev` for server file watching and `npm test` for the automated tests.

## Dashboard and sources

- The dashboard preserves the reference layout: level/location/specialty/date filters, job counts, salary and experience charts, location breakdown, and sortable job table. **Saved jobs** shows one combined **Latest saved jobs** entry with its saved date, time, and local timezone; the timestamp is the newest source snapshot included in those results.
- The **Scraping sources** tab stores search links on the server. Apple Careers is included by default. Add, edit, enable, disable, or remove a source; **Fetch source** collects every enabled source from either the dashboard or a source row.
- Supported sources are `https://jobs.apple.com/en-us/search` (including explicit search filters), `https://jobs.nvidia.com/careers`, and `https://apply.careers.microsoft.com/careers`. NVIDIA and Microsoft URLs are saved with `location=United States`; non-US overrides are rejected. Both adapters also check country-coded location metadata and remove foreign locations from mixed-location postings.
- **Fetch source** refreshes every enabled source, saving separate immutable snapshots and continuing other sources if one fails. Previous jobs from a failed source remain available with a visible notice. The dashboard combines each source's newest completed snapshot or its partial snapshot when none is complete. Disabled and removed sources are excluded from the combined view; their historical snapshots remain readable.
- Every fetch and continuation checkpoint is an immutable snapshot. Older snapshots remain stored and accessible through the API even if their source is edited or removed; the dashboard shows only the latest combined results.
- **Fetch source** continues each enabled source's latest unfinished collection. A running fetch automatically saves checkpoints and continues after each request's time budget. Reloading preserves the last saved checkpoint. A checkpoint can resume only when its recorded search matches the source; snapshots from the earlier implicit team filter require a new fetch from page 1.

## Scraping and filtering

The scraper reads every page of the saved Apple search URL and classifies each title before retaining a job. It does not add team filters: software and firmware engineers can appear under Hardware or other teams. Explicit location, team, and keyword filters in the source URL are preserved. Duplicate role numbers are combined. Software, frontend/backend/full-stack, mobile, embedded/firmware, ML, data engineering, platform, reliability, security engineering, and related programming roles qualify. Retail, sales, hardware-only roles, analysts, data scientists, program managers, and people managers are excluded.

`en-us` selects the English locale, not a country. A source's explicit location filters determine the geographic scope. Without a location filter, results can include roles worldwide.

NVIDIA uses its public careers search feed with a United States location filter. Every returned page is examined; unrelated titles and records without a US location are excluded. Details are read for every matching role, up to a safety ceiling of 1,000, to extract stated USD base salary ranges and minimum experience. Internship hourly ranges are displayed with `/hr` and excluded from annual salary statistics. Listing batches alternate with detail reads, and resumptions fill saved jobs first, so partial searches can still show these fields. Requests are spaced at least one second apart. Existing checkpoints with the earlier 100-role detail limit expand automatically. Fetching and continuation use the same query and raw pagination offset.

Microsoft uses its public careers search feed at `apply.careers.microsoft.com` with the same explicit United States scope. The adapter verifies each role's country metadata and retains software engineering titles with a US location. Microsoft finishes search pagination before reading pending details so detail throttling cannot keep the catalog at the same page. Already enriched roles retain their salary and experience, and the saved detail queue continues after listing coverage is complete. Job details provide stated salary ranges and minimum experience; unstated values remain unknown. Microsoft and NVIDIA share the paced, resumable collection engine, including the 1,000-role detail ceiling. Microsoft requests are spaced at least ten seconds apart. Rate limits double the saved request interval, up to sixty seconds, so resumed checkpoints retain the slower pacing. Microsoft participates in the combined fetch alongside every other enabled source, with separate saved snapshots and resumable checkpoints.

The dashboard displays the actual search link, listings read, result pages read, and software engineering jobs retained. Apple's page count includes unrelated jobs and duplicate location postings, so the retained job count is smaller. Page counts are calculated from Apple's advertised listing total and observed page size, rather than hard-coded.

Descriptions are read for a bounded set of jobs to extract explicitly stated salary ranges and minimum experience. Unknown values remain null and are omitted from those charts; dollar charts only include USD compensation. The footer reports data coverage. A title without a clear seniority is labeled **Not specified**.

Search pages and job details are requested with pacing and finite timeouts. The default safety ceiling is 500 pages, allowing normal searches to reach their actual end. Reaching a request's time budget saves a cursor so the next request starts at the first unfinished page and retains the jobs already collected. Job detail enrichment also resumes independently; unfinished detail extraction does not label complete search coverage as missing jobs.

If Apple returns an empty page while its advertised listing total has not been reached, the scraper retries that same page at most twice, with a one-second wait between attempts. Persistent empty responses save a checkpoint at the unread page instead of reporting complete coverage.

HTTP 403 stops collection without automatic retry. HTTP 429 preserves the source's retry deadline and continues with the other sources first. The active combined fetch then waits for cooldowns and resumes automatically, allowing up to two minutes of total cooldown waiting per invocation. Longer or repeated cooldowns leave a saved checkpoint and show its local resume time. Cancelling the connection cancels the wait. Unexpected formats or repeated pages stop rather than claiming success. Each source makes at most eight checkpoint requests per invocation and pauses after three requests without progress. Fetch source continues the saved checkpoints on the next run. If you set a smaller page ceiling, increase `APPLE_PAGES` before resuming beyond it.

## Configuration and storage

Copy `.env.example` to `.env.local` to override defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local server port |
| `APPLE_PAGES` | `500` | Total search page ceiling per collection (1–500) |
| `APPLE_TIME_BUDGET_MS` | `240000` | Time budget per request/checkpoint in milliseconds |
| `DATA_DIR` | `./data` | Persistent writable directory |

Source settings live in `data/sources.json`; snapshots live in `data/fetches/`. They are ignored by Git. Source changes use atomic, serialized writes within the server process.

This is a single-user local application, bound to the loopback interface by default. It has no authentication. For hosted operation, add authentication, use durable shared storage, and coordinate scraping across instances. A serverless filesystem is not persistent storage; the default configuration intentionally rejects refreshes on Vercel rather than claiming to save data durably. No website deployment is required to run this repository.

## API

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/sources` | Source list and supported adapters |
| POST | `/api/sources` | Add `{ "name": "Apple US", "url": "https://jobs.apple.com/en-us/search?location=united-states-USA" }` |
| PATCH | `/api/sources/:id` | Update name, URL, or enabled flag |
| DELETE | `/api/sources/:id` | Remove source; retain its fetch history |
| GET | `/api/jobs` | Combined latest jobs from all enabled sources, with per-source coverage |
| GET | `/api/jobs?source=:id` | Latest completed or partial snapshot for one source; 404 when empty |
| GET | `/api/fetches` | Fetch summaries and default ID |
| GET | `/api/fetches/:id` | Full snapshot |
| POST | `/api/refresh` or `/api/refresh?source=all` | Fetch all enabled sources; stream progress, `source_done`, `source_error`, and aggregate `done` |
| POST | `/api/refresh?source=:id` | Fetch one source; stream progress and a final `done` or `error` event |
| POST | `/api/refresh?resume=:fetch-id` | Continue a saved checkpoint using its source |

Mutations reject cross-origin browser requests, source URLs are restricted to the supported Apple, NVIDIA, and Microsoft careers endpoints, and request bodies are size limited. The app only reads public listings; it does not sign in or submit applications.

## Project structure

```text
public/              Dashboard, charts, and source management
lib/apple.js         Apple scraper and software-role classifier
lib/nvidia.js        US-only NVIDIA scraper
lib/microsoft.js     US-only Microsoft scraper
lib/eightfold.js     Shared NVIDIA and Microsoft collection engine
lib/providers.js     Source validation and adapter dispatch
lib/collect.js       Multi-source fetching and checkpoint continuation
lib/store.js         Source configuration and fetch history
server.js            Static files and HTTP API
scripts/fetch-jobs.js Command-line collection
test/                Parser, filtering, storage, and API tests
```

The frontend was adapted from the user's referenced `swe-job` repository. The backend uses Apple, NVIDIA, and Microsoft as its data sources.

