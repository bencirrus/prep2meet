# prep2meet

Self-contained **pre-call briefing** tool for SaaS sellers: enter a **company name**, **US ticker**, or **website**. The app pulls a **small set of public pages** (company IR portal, SEC EDGAR when applicable, homepage HTML, a Wikipedia summary, Google News RSS, and optional 10‑K excerpt), then uses **OpenAI** to return a **structured JSON briefing** (opportunities, risks, MD&A themes when 10‑K text is present, financials-from-excerpt, news hooks, prep checklist).

## Architecture

| Piece | Role |
|--------|------|
| **Static UI** (`public/`) | One field, one button, optional settings. Host on **GitHub Pages**, **Vercel**, or open locally. |
| **Vercel Serverless API** (`api/`) | Server-side `fetch` with correct **SEC User-Agent**, **HTML/RSS retrieval**, **size caps**, **IR-portal 10-K discovery**, and **OpenAI** call. Avoids browser CORS and keeps keys off the client. |
| **Cloudflare Worker** (`worker/index.js`) | Original worker implementation — still works if you prefer Cloudflare. |

**Why a server-side function?** Browsers cannot reliably call SEC EDGAR, many corporate sites, or RSS feeds from static hosting because of **CORS**, and SEC expects a **declared User-Agent**. A single serverless function is the smallest production-shaped fix versus running a full backend.

**Why OpenAI?** The prompt asks for synthesis and sales framing. Rule-based extraction from arbitrary HTML is brittle; one model call keeps dependencies minimal.

**No database, no auth, no accounts** — nothing is stored server-side by this code.

## How data is retrieved and summarized

1. **Public vs private (US-listed)**
   - Loads [SEC `company_tickers.json`](https://www.sec.gov/files/company_tickers.json) (cached in memory for ~12h).
   - **Ticker**: exact match. **Name**: substring / token score with a short-query guard.
   - Match → `public_us`; no match → `private_or_non_us` (still try open-web sources).

2. **Official website**
   - **Wikidata** (`wbsearchentities` + `P856` official website) — no API key.

3. **Investor relations + 10-K discovery**
   - Scans homepage `href`s for paths containing `investor`, `/ir`, `shareholder`, etc., resolves relative URLs.
   - **IR-portal 10-K**: scans the IR page for links matching `10-K`, `annual-report`, `form10k`, etc. — this retrieves the filing directly from the company's own portal, **avoiding SEC EDGAR** for the document itself.
   - **SEC EDGAR fallback**: if no IR-portal 10-K is found, falls back to `https://data.sec.gov/submissions/CIK##########.json` to pick the most recent 10-K and builds the Archives URL.

4. **News**
   - **Google News RSS** for the resolved company name (no key).

5. **Context**
   - **Wikipedia** OpenSearch + REST summary for a neutral overview paragraph.

6. **Social / blog**
   - **Regex on homepage HTML** for common social URLs (LinkedIn, X/Twitter, YouTube, etc.). Not a substitute for official APIs; labeled as hints.

7. **Summarization**
   - Server POSTs excerpts to **OpenAI** `gpt-4o-mini` with **`response_format: json_object`** and a fixed schema (headline, bullets, financials object, checklist).

## Quick start (local)

```bash
cd prep2meet
npm install
```

### Option A: Vercel dev (recommended)

Create a `.env.local` file (git-ignored):

```
OPENAI_API_KEY=sk-...
```

Run:

```bash
npx vercel dev
```

This serves both the static UI and the API on the same port (default `http://localhost:3000`).

### Option B: Cloudflare Worker (legacy)

Create `.dev.vars` in the project root (git-ignored); see `.dev.vars.example`:

```
OPENAI_API_KEY=sk-...
```

Run:

```bash
npx wrangler dev
```

Default: `http://127.0.0.1:8787`. Then in another terminal:

```bash
npx serve public -p 8080
```

Open `http://127.0.0.1:8080`, expand **API & settings**, set **API base URL** to `http://127.0.0.1:8787`.

## Deploy

### Vercel (recommended — serves both UI and API)

1. Push this repo to GitHub.
2. Import the repo on [vercel.com/new](https://vercel.com/new).
3. In the Vercel dashboard, go to **Settings → Environment Variables** and add:
   - `OPENAI_API_KEY` = your OpenAI key
   - (Optional) `PUBLIC_ORIGINS` = comma-separated allowed origins for CORS
4. Deploy. Vercel will serve `public/` as static files and `api/` as serverless functions.
5. Your app is live at `https://your-project.vercel.app`.

### GitHub Pages (static UI only)

Use this if you want the UI on your own GitHub Pages domain and the API on Vercel separately.

1. In your repo settings, go to **Settings → Pages → Source** and select **GitHub Actions**.
2. The included workflow (`.github/workflows/pages.yml`) will automatically deploy the `public/` folder on every push to `main`.
3. After deploy, open the site, expand **API & settings**, and set the **API base URL** to your Vercel deployment (e.g. `https://prep2meet.vercel.app`).
4. Shortcut: append `?api=https://prep2meet.vercel.app` to the GitHub Pages URL to prefill the API base.

### Cloudflare Worker (legacy)

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

## Deployment combinations

| UI hosted on | API hosted on | Config needed |
|---|---|---|
| **Vercel** | **Vercel** (same project) | Nothing — same origin, auto-detected |
| **GitHub Pages** | **Vercel** | Set API base URL in the UI or use `?api=` query param |
| **GitHub Pages** | **Cloudflare Worker** | Set API base URL in the UI or use `?api=` query param |
| **Local** (`file://`) | **Vercel** or **Worker** | Set API base URL in the UI |

## File structure

```
prep2meet/
├── api/                  # Vercel serverless functions
│   ├── brief.js          # POST /api/brief — main briefing endpoint
│   └── health.js         # GET /api/health — health check
├── public/               # Static UI (served by Vercel or GitHub Pages)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── worker/               # Cloudflare Worker (legacy, still functional)
│   └── index.js
├── .github/workflows/
│   └── pages.yml         # GitHub Pages deployment workflow
├── vercel.json           # Vercel routing config
├── wrangler.toml         # Cloudflare Worker config (legacy)
└── package.json
```

## Limitations and future enhancements

- **US-centric listing detection** — Non-US tickers and many ADR edge cases are not modeled; "private" here means "no match in SEC ticker file," not a legal determination.
- **Heuristic IR + 10‑K** — IR link detection is pattern-based; 10‑K is often huge HTML — only an **excerpt** is pulled, so MD&A coverage is **best-effort**.
- **Single model call** — One `gpt-4o-mini` request keeps latency ≤ ~15 s and cost < $0.01 per brief for a typical public company.
- **No caching** — Every request re-fetches. Adding a KV layer (Vercel KV, Cloudflare KV) for SEC tickers / Wikipedia would cut cold-start cost.
- **IR-portal 10-K discovery** — Pattern-based link detection on IR pages; companies with non-standard IR page structures may not have their 10-K auto-detected.
