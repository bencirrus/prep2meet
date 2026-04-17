/**
 * prep2meet — Vercel Serverless Function: POST /api/brief
 *
 * Fetches public sources (SEC EDGAR, company IR portal, site HTML, news RSS,
 * Wikipedia / Wikidata) and asks OpenAI to produce a structured sales briefing.
 *
 * Environment variable: OPENAI_API_KEY (set in Vercel dashboard).
 */

const SEC_UA = "prep2meet/1.0 (https://github.com; prep2meet SEC EDGAR bot)";
const DEFAULT_UA = "prep2meet/1.0 (https://github.com; lightweight fetch)";
const MAX_HTML_CHARS = 45000;
const MAX_10K_CHARS = 95000;
const MAX_NEWS_ITEMS = 8;

/* ─── CORS helpers ─── */

function corsHeaders(req) {
  const origin = req.headers["origin"] || req.headers["Origin"] || "";
  const allowed = (process.env.PUBLIC_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let allow = "*";
  if (!allowed.includes("*")) {
    allow = allowed.includes(origin) ? origin : allowed[0] || "*";
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/* ─── Vercel handler ─── */

export default async function handler(req, res) {
  const cors = corsHeaders(req);
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const query = (body.query || "").trim();
  const openaiKey = body.openaiApiKey || process.env.OPENAI_API_KEY || "";

  if (!query) return res.status(400).json({ error: "Missing query (company name or ticker)" });
  if (!openaiKey) {
    return res.status(400).json({
      error:
        "OpenAI API key required: pass openaiApiKey in the request body or set OPENAI_API_KEY as an environment variable.",
    });
  }

  try {
    const pack = await gatherBriefingPack(query);
    const briefing = await synthesizeBriefing(pack, openaiKey);
    return res.status(200).json({ briefing, meta: pack.meta });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Brief generation failed" });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Data-gathering pipeline
   ═══════════════════════════════════════════════════════════════════════════ */

async function gatherBriefingPack(rawQuery) {
  const meta = {
    query: rawQuery,
    resolvedName: null,
    ticker: null,
    cik: null,
    classification: "unknown",
    website: null,
    irUrl: null,
    tenKUrl: null,
    tenKSource: null,
    sourcesUsed: [],
    warnings: [],
  };

  const isLikelyUrl =
    /^https?:\/\//i.test(rawQuery) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(rawQuery);
  let websiteHint = null;
  let searchQuery = rawQuery;

  if (isLikelyUrl) {
    websiteHint = rawQuery.startsWith("http") ? rawQuery : `https://${rawQuery}`;
    searchQuery = rawQuery.replace(/^https?:\/\//, "").split("/")[0];
  }

  /* ── SEC ticker lookup ── */
  const tickers = await loadSecTickers();
  const secMatch = findSecMatch(rawQuery, tickers);
  let edgarTenK = null;

  if (secMatch) {
    meta.classification = "public_us";
    meta.cik = secMatch.cik_str;
    meta.ticker = secMatch.ticker;
    meta.resolvedName = secMatch.title;
    meta.sourcesUsed.push("SEC company tickers");

    const sub = await fetchSecJson(
      `https://data.sec.gov/submissions/CIK${String(secMatch.cik_str).padStart(10, "0")}.json`
    );
    if (sub.entityName) meta.resolvedName = sub.entityName;

    /* Save the SEC EDGAR 10-K candidate but don't assign yet —
       we prefer the company's own IR portal if available. */
    edgarTenK = pickLatestTenK(sub);

    if (!websiteHint) {
      websiteHint = await resolveOfficialWebsite(searchQuery, meta.resolvedName);
    }
  } else {
    meta.classification = "private_or_non_us";
    meta.resolvedName = rawQuery;
    if (!websiteHint) {
      websiteHint = await resolveOfficialWebsite(searchQuery, rawQuery);
    }
    meta.sourcesUsed.push("No SEC ticker match — treated as private / non-US registrant");
  }

  meta.website = websiteHint;
  if (meta.website) meta.sourcesUsed.push(`Website HTML: ${meta.website}`);

  /* ── Wikipedia ── */
  const wiki = await fetchWikipediaSummary(searchQuery);
  if (wiki.extract) meta.sourcesUsed.push("Wikipedia summary");

  /* ── News ── */
  const newsItems = await fetchGoogleNewsRss(meta.resolvedName || searchQuery);
  if (newsItems.length) meta.sourcesUsed.push("Google News RSS (headlines + links)");

  /* ── Homepage fetch ── */
  let siteText = "";
  let homeHtml = "";
  if (meta.website) {
    homeHtml = await fetchText(meta.website, DEFAULT_UA, MAX_HTML_CHARS * 2);
    if (homeHtml) {
      siteText = htmlToText(homeHtml).slice(0, MAX_HTML_CHARS);
      const irFromSite = findInvestorRelationsUrl(homeHtml, meta.website);
      if (irFromSite) {
        meta.irUrl = irFromSite;
        meta.sourcesUsed.push(`Investor relations page: ${irFromSite}`);
      }
    } else {
      meta.warnings.push(
        "Could not fetch company homepage (blocked, timeout, or invalid URL)."
      );
    }
  }

  /* ── IR page fetch + try IR-based 10-K discovery ── */
  let irText = "";
  if (meta.irUrl && meta.irUrl !== meta.website) {
    const irHtml = await fetchText(meta.irUrl, DEFAULT_UA, MAX_HTML_CHARS);
    if (irHtml) {
      irText = htmlToText(irHtml).slice(0, MAX_HTML_CHARS);

      /* Try to find a 10-K / annual report directly on the company's IR
         portal — this is the preferred path because it avoids SEC EDGAR
         entirely for the 10-K document. */
      const irTenK = findTenKOnIrPage(irHtml, meta.irUrl);
      if (irTenK) {
        meta.tenKUrl = irTenK;
        meta.tenKSource = "ir_portal";
        meta.sourcesUsed.push(`10-K / Annual Report found on IR portal: ${irTenK}`);
      }
    }
  }

  /* ── SEC EDGAR fallback for 10-K (only if IR portal didn't find one) ── */
  if (!meta.tenKUrl && edgarTenK) {
    meta.tenKUrl = edgarTenK.url;
    meta.tenKSource = "sec_edgar";
    meta.sourcesUsed.push("Latest 10-K primary document via SEC EDGAR (excerpt)");
  }

  /* ── 10-K text ── */
  let tenKText = "";
  if (meta.tenKUrl) {
    const kHtml = await fetchText(meta.tenKUrl, meta.tenKSource === "sec_edgar" ? SEC_UA : DEFAULT_UA, MAX_10K_CHARS * 2);
    if (kHtml) {
      tenKText = htmlToText(kHtml).slice(0, MAX_10K_CHARS);
    } else {
      meta.warnings.push("10-K document could not be fetched (size, format, or network).");
    }
  }

  /* ── Social hints ── */
  const socialHints = homeHtml ? extractSocialBlogHints(homeHtml) : "";

  return {
    meta,
    excerpts: {
      wikipedia: wiki.extract || "",
      websiteHome: siteText,
      investorRelations: irText,
      tenK: tenKText,
      news: newsItems,
      socialBlogHints: socialHints,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   OpenAI summarization
   ═══════════════════════════════════════════════════════════════════════════ */

async function synthesizeBriefing(pack, apiKey) {
  const { meta, excerpts } = pack;
  const userPayload = {
    instructions:
      "You are helping an enterprise SaaS account executive prepare for a customer call. Be factual; if something is not in the excerpts, say unknown or not found. Prefer actionable sales angles over generic praise.",
    companyMeta: meta,
    sourceExcerpts: {
      wikipedia: excerpts.wikipedia.slice(0, 12000),
      websiteHome: excerpts.websiteHome.slice(0, 12000),
      investorRelations: excerpts.investorRelations.slice(0, 12000),
      tenK: excerpts.tenK.slice(0, 20000),
      newsHeadlines: excerpts.news,
      socialOrBlogHints: excerpts.socialBlogHints || "",
    },
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.25,
      max_tokens: 2500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Return ONLY valid JSON matching this shape:
{
  "headline": "string — one line company snapshot for the rep",
  "classification": "public_us | private_or_non_us | unknown",
  "identifiers": { "legalName": "string|null", "ticker": "string|null", "website": "string|null", "irUrl": "string|null", "tenKUrl": "string|null" },
  "snapshot": ["3-6 bullets: what they do, who they sell to, motion to verify on call"],
  "opportunities": ["3-6 bullets — concrete hooks tied to excerpts"],
  "risks": ["3-6 bullets — business, competitive, budget, timing"],
  "mdnaThemes": ["If 10-K excerpt present: 3-6 bullets on management narrative themes; else empty array"],
  "financials": {
    "revenue": "string — cite period if visible in 10-K excerpt, else 'Not found in excerpt'",
    "growth": "string",
    "profitability": "string",
    "segments": "string"
  },
  "newsHighlights": ["up to 6 short bullets with implied angle for the seller"],
  "digitalPresence": "1 short paragraph: blog/social signals from hints + website text",
  "prepChecklist": ["6-10 very specific questions or checks for the AE before/during the meeting"]
}`,
        },
        {
          role: "user",
          content: JSON.stringify(userPayload),
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");
  try {
    return JSON.parse(content);
  } catch {
    return { parseError: true, raw: content };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEC ticker cache + matching
   ═══════════════════════════════════════════════════════════════════════════ */

let tickerCache = { at: 0, list: null };
const TICKER_TTL_MS = 1000 * 60 * 60 * 12;

async function loadSecTickers() {
  const now = Date.now();
  if (tickerCache.list && now - tickerCache.at < TICKER_TTL_MS) {
    return tickerCache.list;
  }
  const r = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("SEC ticker file unavailable");
  const j = await r.json();
  const list = normalizeTickerJson(j);
  tickerCache = { at: now, list };
  return list;
}

function normalizeTickerJson(j) {
  if (Array.isArray(j?.data)) {
    return j.data.map((row) => ({
      cik_str: row[0],
      ticker: String(row[1] || "").toUpperCase(),
      title: row[2],
    }));
  }
  return Object.values(j || {})
    .filter((v) => v && typeof v === "object" && v.ticker)
    .map((v) => ({
      cik_str: v.cik_str,
      ticker: String(v.ticker || "").toUpperCase(),
      title: v.title,
    }));
}

function findSecMatch(query, list) {
  const q = query.trim();
  if (!q) return null;
  const upper = q.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  if (upper.length >= 1 && upper.length <= 6 && /^[A-Z0-9.-]+$/.test(upper)) {
    const exact = list.find((r) => r.ticker === upper);
    if (exact) return exact;
  }
  const ql = q.toLowerCase();
  if (ql.length < 3) return null;
  const words = ql.split(/\s+/).filter((w) => w.length > 1);
  let best = null;
  let bestScore = 0;
  for (const row of list) {
    const t = (row.title || "").toLowerCase();
    if (t === ql) return row;
    if (t.includes(ql)) {
      const score = 100 + ql.length;
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
      continue;
    }
    let score = 0;
    for (const w of words) {
      if (t.includes(w)) score += w.length;
    }
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  if (best && bestScore >= 4) return best;
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEC JSON + 10-K pick
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchSecJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("SEC submissions request failed");
  return r.json();
}

function pickLatestTenK(sub) {
  const recent = sub?.filings?.recent;
  if (!recent?.form) return null;
  const { form, accessionNumber, primaryDocument, filingDate } = recent;
  for (let i = 0; i < form.length; i++) {
    if (form[i] === "10-K") {
      const acc = accessionNumber[i].replace(/-/g, "");
      const cikNum = parseInt(String(sub.cik).padStart(10, "0"), 10);
      const doc = primaryDocument[i];
      const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${doc}`;
      return { url, filingDate: filingDate[i] };
    }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Official website via Wikidata
   ═══════════════════════════════════════════════════════════════════════════ */

async function resolveOfficialWebsite(searchTerm, displayName) {
  const q = encodeURIComponent(displayName || searchTerm);
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=en&format=json&limit=3&type=item`;
  const r = await fetch(url, { headers: { "User-Agent": DEFAULT_UA } });
  if (!r.ok) return null;
  const j = await r.json();
  const id = j.search?.[0]?.id;
  if (!id) return null;
  const r2 = await fetch(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&format=json&props=claims`,
    { headers: { "User-Agent": DEFAULT_UA } }
  );
  if (!r2.ok) return null;
  const j2 = await r2.json();
  const claims = j2.entities?.[id]?.claims?.P856;
  const first = claims?.[0]?.mainsnak?.datavalue?.value;
  return typeof first === "string" ? first : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Wikipedia summary
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchWikipediaSummary(term) {
  const open = await fetch(
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(term)}&limit=1&namespace=0&format=json`,
    { headers: { "User-Agent": DEFAULT_UA } }
  );
  if (!open.ok) return { extract: "" };
  const oj = await open.json();
  const title = oj[1]?.[0];
  if (!title) return { extract: "" };
  const sr = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { "User-Agent": DEFAULT_UA } }
  );
  if (!sr.ok) return { extract: "" };
  const sj = await sr.json();
  return { title, extract: sj.extract || "" };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Google News RSS
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchGoogleNewsRss(query) {
  const q = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { "User-Agent": DEFAULT_UA } });
  if (!r.ok) return [];
  const xml = await r.text();
  return parseRssItems(xml).slice(0, MAX_NEWS_ITEMS);
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = stripCdata(
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
    );
    const link = stripCdata(
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || ""
    );
    if (title) items.push({ title, link });
  }
  return items;
}

function stripCdata(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   HTML / text fetch with timeout + size cap
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchText(url, userAgent, maxBytesHint) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    clearTimeout(to);
    if (!r.ok) return "";
    const buf = await r.arrayBuffer();
    const slice =
      buf.byteLength > maxBytesHint ? buf.slice(0, maxBytesHint) : buf;
    const dec = new TextDecoder("utf-8", { fatal: false });
    return dec.decode(slice);
  } catch {
    return "";
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HTML → text, IR link detection, social hints
   ═══════════════════════════════════════════════════════════════════════════ */

function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|li|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function findInvestorRelationsUrl(html, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1]
  );
  const candidates = hrefs.filter((h) => {
    const l = h.toLowerCase();
    return (
      l.includes("investor") ||
      l.includes("investors") ||
      l.includes("/ir") ||
      l.includes("shareholder") ||
      l.includes("sec-filings") ||
      l.includes("sec_filings")
    );
  });
  for (const h of candidates) {
    try {
      const abs = new URL(h, base).href;
      if (abs.startsWith("http")) return abs;
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Scan an IR page's HTML for links that look like a 10-K / annual report.
 * Returns the first plausible absolute URL or null.
 */
function findTenKOnIrPage(irHtml, irBaseUrl) {
  let base;
  try {
    base = new URL(irBaseUrl);
  } catch {
    return null;
  }

  const hrefs = [...irHtml.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1]
  );

  /* Patterns that strongly suggest a 10-K or annual report filing */
  const tenKPatterns = [
    /10-?k/i,
    /annual[_-]?report/i,
    /annual[_-]?filing/i,
    /form[_-]?10k/i,
  ];

  /* File extensions we care about (HTML filings or PDFs) */
  const docExtensions = /\.(htm|html|pdf)(\?|$)/i;

  for (const h of hrefs) {
    const lower = h.toLowerCase();
    const matchesPattern = tenKPatterns.some((re) => re.test(lower));
    if (!matchesPattern) continue;
    /* Prefer actual documents, not search/filter pages */
    if (docExtensions.test(lower) || lower.includes("viewer")) {
      try {
        return new URL(h, base).href;
      } catch {
        /* skip */
      }
    }
  }

  /* Second pass: accept any link that matches the pattern even without a doc extension */
  for (const h of hrefs) {
    if (tenKPatterns.some((re) => re.test(h))) {
      try {
        return new URL(h, base).href;
      } catch {
        /* skip */
      }
    }
  }

  return null;
}

function extractSocialBlogHints(text) {
  const found = new Set();
  const patterns = [
    /https?:\/\/(?:www\.)?linkedin\.com\/[^\s)"']+/gi,
    /https?:\/\/(?:www\.)?twitter\.com\/[^\s)"']+/gi,
    /https?:\/\/x\.com\/[^\s)"']+/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/[^\s)"']+/gi,
    /https?:\/\/(?:www\.)?facebook\.com\/[^\s)"']+/gi,
    /https?:\/\/(?:www\.)?instagram\.com\/[^\s)"']+/gi,
  ];
  for (const re of patterns) {
    let m;
    const t = text.slice(0, 15000);
    while ((m = re.exec(t)) !== null) found.add(m[0]);
  }
  return [...found].slice(0, 12).join("\n");
}
