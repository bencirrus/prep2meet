# prep2meet

Self-contained **pre-call briefing** tool for SaaS sellers: enter a **company name**, **US ticker**, or **website**. The app pulls a **small set of public pages** (SEC EDGAR when applicable, homepage HTML, a Wikipedia summary, Google News RSS, and optional IR page + 10‑K excerpt), then uses **OpenAI** to return a **structured JSON briefing** (opportunities, risks, MD&A themes when 10‑K text is present, financials-from-excerpt, news hooks, prep checklist).

## Architecture (minimal on purpose)

| Piece | Role |
|--------|------|
| **Static UI** (`public/`) | One field, one button, optional settings. Host on **GitHub Pages**, any static host, or open locally. |
| **Cloudflare Worker** (`worker/index.js`) | **Server-side `fetch`** with correct **SEC User-Agent**, **HTML/RSS retrieval**, **size caps**, and **OpenAI** call. Avoids browser CORS and keeps keys off GitHub if you use Worker secrets. |

**Why a Worker?** Browsers cannot reliably call SEC EDGAR, many corporate sites, or RSS feeds from static hosting because of **CORS**, and SEC expects a **declared User-Agent**. A single Worker is the smallest production-shaped fix versus running a full backend.

**Why OpenAI?** The prompt asks for synthesis and sales framing. Rule-based extraction from arbitrary HTML is brittle; one model call keeps dependencies minimal.

**No database, no auth, no accounts** — nothing is stored server-side by this code.

## How data is retrieved and summarized

1. **Public vs private (US-listed)**  
   - Loads [SEC `company_tickers.json`](https://www.sec.gov/files/company_tickers.json) (cached in memory for ~12h per isolate).  
   - **Ticker**: exact match. **Name**: substring / token score with a short-query guard.  
   - Match ⇒ `public_us`; no match ⇒ `private_or_non_us` (still try open-web sources).

2. **Official website**  
   - **Wikidata** (`wbsearchentities` + `P856` official website) — no API key.

3. **If public**  
   - **Submissions JSON**: `https://data.sec.gov/submissions/CIK##########.json`  
   - Picks the **most recent 10‑K** in `filings.recent`, builds the **Archives URL** for `primaryDocument`.  
   - Fetches a **truncated** HTML/text window (see caps in `worker/index.js`).

4. **Investor relations**  
   - Scans homepage `href`s for paths containing `investor`, `/ir`, `shareholder`, etc., resolves relative URLs.

5. **News**  
   - **Google News RSS** for the resolved company name (no key).

6. **Context**  
   - **Wikipedia** OpenSearch + REST summary for a neutral overview paragraph.

7. **Social / blog**  
   - **Regex on homepage HTML** for common social URLs (LinkedIn, X/Twitter, YouTube, etc.). Not a substitute for official APIs; labeled as hints.

8. **Summarization**  
   - Worker POSTs excerpts to **OpenAI** `gpt-4o-mini` with **`response_format: json_object`** and a fixed schema (headline, bullets, financials object, checklist).

## Quick start (local)

```bash
cd prep2meet
npm install
```

### 1) Worker

Create `.dev.vars` in the project root (git-ignored); see `.dev.vars.example`:

```
OPENAI_API_KEY=sk-...
```

Run:

```bash
npx wrangler dev
```

Default: `http://127.0.0.1:8787`

### 2) UI

In another terminal:

```bash
npx serve public -p 8080
```

Open `http://127.0.0.1:8080`, set **Worker base URL** to `http://127.0.0.1:8787`. Paste an **OpenAI key** in the UI *or* rely on `OPENAI_API_KEY` in `.dev.vars` / Worker secrets (leave the UI field empty in that case).

## Deploy

### Cloudflare Worker (production)

1. `npm install`  
2. `npx wrangler login`  
3. Set secrets: `npx wrangler secret put OPENAI_API_KEY`  
4. (Recommended) Restrict CORS in `wrangler.toml`:

```toml
[vars]
PUBLIC_ORIGINS = "https://YOUR_GH_USER.github.io,http://127.0.0.1:8080"
```

5. `npx wrangler deploy`  
6. Note the Worker URL (e.g. `https://prep2meet.your-subdomain.workers.dev`).

### GitHub Pages (static UI)

- **Option A:** Enable Pages with a workflow that publishes the `public/` folder (e.g. [peaceiris/actions-gh-pages](https://github.com/peaceiris/actions-gh-pages) with `publish_dir: ./public`).  
- **Option B:** Copy `public/*` into a `docs/` folder if you use “Deploy from branch” with `/docs`.

After deploy, open the site, expand **Worker & API**, paste your Worker origin, and optionally add `?worker=https://...` to the URL once to prefill.

## Limitations and future enhancements

- **US-centric listing detection** — Non-US tickers and many ADR edge cases are not modeled; “private” here means “no match in SEC ticker file,” not a legal determination.  
- **Heuristic IR + 10‑K** — IR link detection is pattern-based; 10‑K is often huge HTML — only an **excerpt** is pulled, so MD&A coverage is **best-effort**.  
- **News RSS** — Headlines can be delayed or noisy; always verify on the call.  
- **Social** — No authenticated APIs; only URLs spotted in HTML.  
- **Wikidata / Wikipedia** — Can be wrong or stale for fast-moving private companies.  
- **Rate limits** — SEC asks for a **reasonable request rate**; this app fetches only a handful of URLs per briefing.  
- **Enhancements** — Optional second-stage fetch of the MD&A exhibit only, richer blog discovery (RSS autodiscovery), non-US exchanges, PDF text extraction, org-specific allowlists for domains.

## SEC fair use

Use a **real contact** in `SEC_UA` / `DEFAULT_UA` inside `worker/index.js` before heavy production use so your traffic aligns with [SEC.gov guidance on programmatic access](https://www.sec.gov/os/accessing-edgar-data).
# prep2meet
