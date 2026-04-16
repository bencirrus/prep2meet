const $ = (id) => document.getElementById(id);

const STORAGE_API_BASE = "prep2meet_api_base";

function loadDefaults() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("api") || params.get("worker");
  const stored = localStorage.getItem(STORAGE_API_BASE);

  if (fromQuery) {
    $("apiBase").value = fromQuery;
    localStorage.setItem(STORAGE_API_BASE, fromQuery.replace(/\/$/, ""));
  } else if (stored) {
    $("apiBase").value = stored;
  }

  updateApiHint();
}

function saveApiBase() {
  const v = $("apiBase").value.trim();
  if (v) localStorage.setItem(STORAGE_API_BASE, v.replace(/\/$/, ""));
}

/**
 * Resolve the API endpoint URL.
 * - If the user typed a base URL → use it.
 * - If the page is served from a Vercel deploy (same origin has /api) → same origin.
 * - Otherwise → require the user to fill it in.
 */
function resolveApiBase() {
  const explicit = ($("apiBase").value || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  /* Same-origin when hosted on Vercel (the /api routes live next to the static files) */
  return window.location.origin;
}

function apiUrl() {
  return `${resolveApiBase()}/api/brief`;
}

function updateApiHint() {
  const el = $("apiHint");
  if (!el) return;
  const explicit = ($("apiBase").value || "").trim();
  if (explicit) {
    el.textContent = "Using the API base URL you provided.";
  } else {
    el.textContent =
      "Auto-detected: same origin (" +
      window.location.origin +
      "). Set a URL here if your API is hosted elsewhere (e.g. on Vercel).";
  }
}

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderBriefing(data, meta) {
  const b = data.briefing;
  const out = $("output");
  out.classList.remove("hidden");

  if (b.parseError) {
    out.innerHTML = `<h2>Briefing</h2><pre class="raw">${esc(b.raw)}</pre>`;
    return;
  }

  const ids = b.identifiers || {};
  const fin = b.financials || {};

  const warnings =
    meta.warnings && meta.warnings.length
      ? `<div class="warnings"><strong>Warnings</strong><ul class="clean">${meta.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
      : "";

  const pills = [
    b.classification && `<span class="meta-pill">${esc(b.classification)}</span>`,
    ids.ticker && `<span class="meta-pill">${esc(ids.ticker)}</span>`,
    ids.website && `<span class="meta-pill">${esc(ids.website)}</span>`,
  ]
    .filter(Boolean)
    .join("");

  const list = (title, items) => {
    if (!items || !items.length) return "";
    return `<div class="section"><h3>${esc(title)}</h3><ul class="clean">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  };

  out.innerHTML = `
    <h2>Briefing</h2>
    ${warnings}
    <div class="headline">${esc(b.headline)}</div>
    <div>${pills}</div>
    ${list("Snapshot", b.snapshot)}
    ${list("Opportunities", b.opportunities)}
    ${list("Risks", b.risks)}
    ${list("MD&A themes", b.mdnaThemes)}
    <div class="section">
      <h3>Financials (from excerpts)</h3>
      <dl class="fin-grid">
        <div><dt>Revenue</dt><dd>${esc(fin.revenue)}</dd></div>
        <div><dt>Growth</dt><dd>${esc(fin.growth)}</dd></div>
        <div><dt>Profitability</dt><dd>${esc(fin.profitability)}</dd></div>
        <div><dt>Segments</dt><dd>${esc(fin.segments)}</dd></div>
      </dl>
    </div>
    ${list("News highlights", b.newsHighlights)}
    <div class="section">
      <h3>Digital presence</h3>
      <p>${esc(b.digitalPresence)}</p>
    </div>
    ${list("Prep checklist", b.prepChecklist)}
    <div class="sources">
      <strong>Sources used</strong>
      <ul class="clean">${(meta.sourcesUsed || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
    </div>
  `;
}

async function runBrief() {
  const query = $("query").value.trim();
  const key = $("apiKey").value.trim();
  saveApiBase();

  if (!query) {
    setStatus("Enter a company name or ticker.", true);
    return;
  }

  $("run").disabled = true;
  setStatus("Gathering a few public sources and summarizing…");

  try {
    const res = await fetch(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...(key ? { openaiApiKey: key } : {}) }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(payload.error || `Request failed (${res.status})`, true);
      $("output").classList.add("hidden");
      return;
    }
    setStatus("");
    renderBriefing(payload, payload.meta || {});
    $("output").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setStatus(e.message || "Network error — check API base URL and CORS.", true);
    $("output").classList.add("hidden");
  } finally {
    $("run").disabled = false;
  }
}

$("run").addEventListener("click", runBrief);
$("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runBrief();
});

const apiBaseEl = $("apiBase");
if (apiBaseEl) apiBaseEl.addEventListener("input", updateApiHint);

loadDefaults();
