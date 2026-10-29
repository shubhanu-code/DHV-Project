import express from "express";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const DATA_FILE = fileURLToPath(new URL("../data/processed/rankings.json", import.meta.url));
const AUDIT_FILE = fileURLToPath(new URL("../data/processed/audit_report.json", import.meta.url));
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean);

app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// CORS (only for explicitly allowed origins; the Vite dev proxy needs none)
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "100kb" }));

// ---------------------------------------------------------------------------
// Dataset loading. The file is ~7 MB, so it is parsed once and re-read only
// when it changes on disk (e.g. after re-running the collection pipeline).
// ---------------------------------------------------------------------------
const nameKey = (name) => String(name ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const finite = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

function emptyDataset(notice) {
  return {
    metadata: { data_notice: notice },
    categories: [],
    years: [],
    states: [],
    records: [],
    loaded: false,
    gzip: null,
  };
}

const CITY_ALIASES = { calcutta: "kolkata", madras: "chennai", bombay: "mumbai", trichur: "thrissur", tiruchirapalli: "tiruchirappalli", trichy: "tiruchirappalli", "new delhi": "delhi" };
function cityKey(city) {
  const base = String(city ?? "").toLowerCase().replace(/\b(?:district|dist)\b\.?/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return CITY_ALIASES[base] || base;
}

function buildDataset(parsed) {
  const raw = Array.isArray(parsed?.records) ? parsed.records : [];
  const publishedName = (record) => record.institution_name_standard || record.institution_name_original || "";

  // Institution IDs changed format between 2017, 2018 and 2019+, and names are sometimes
  // published with different punctuation, so institutions are grouped by a normalised name.
  // Some names are shared by genuinely different institutions (e.g. "St. Xavier's College"
  // in Kolkata and Mumbai): when a name repeats within one year and category, the city is
  // added to the key so those institutions are not merged.
  const seen = new Map();
  const ambiguous = new Set();
  for (const record of raw) {
    const slot = `${record.year}|${record.category_standard}|${nameKey(publishedName(record))}`;
    const count = (seen.get(slot) || 0) + 1;
    seen.set(slot, count);
    if (count > 1) ambiguous.add(nameKey(publishedName(record)));
  }
  const keyOf = (record) => {
    const base = nameKey(publishedName(record));
    return ambiguous.has(base) ? `${base}|${cityKey(record.city_original)}` : base;
  };

  // Display the most recently published spelling of each institution.
  const latest = new Map();
  for (const record of raw) {
    const key = keyOf(record);
    const year = Number(record.year) || 0;
    const current = latest.get(key);
    if (!current || year > current.year) {
      const name = publishedName(record);
      const city = String(record.city_original ?? "").replace(/^\s*(?:district|dist\.?)\s*/i, "").trim();
      latest.set(key, { year, name: ambiguous.has(nameKey(name)) && city ? `${name} (${city})` : name });
    }
  }
  const records = raw
    .map((record) => {
      const published = publishedName(record);
      const key = keyOf(record);
      return {
        ...record,
        year: Number(record.year),
        institution: latest.get(key)?.name || published,
        institution_published_name: published,
        institution_key: key,
        state: record.state_standard || record.state_original || "",
        city: record.city_original || "",
        category: record.category_standard || record.category_original || "",
        rank: finite(record.rank),
        score: finite(record.score),
        tlr: finite(record.tlr),
        rpc: finite(record.rpc),
        go: finite(record.go),
        oi: finite(record.oi),
        pr: finite(record.perception),
      };
    })
    .filter((record) => Number.isInteger(record.year) && record.institution);

  const categories = [...new Set([...(Array.isArray(parsed?.categories) ? parsed.categories : []), ...records.map((r) => r.category)])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const years = [...new Set(records.map((r) => r.year))].sort((a, b) => a - b);
  const states = [...new Set(records.map((r) => r.state).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const loaded = records.length > 0;
  const metadata = { ...(parsed?.metadata ?? {}) };
  if (!loaded) metadata.data_notice = "The prepared dataset contains no records. Run scripts/collect_nirf.py first.";

  const dataset = { metadata, categories, years, states, records, loaded, gzip: null };
  if (loaded) {
    const body = Buffer.from(JSON.stringify(buildRankingsPayload(dataset, records)));
    dataset.gzip = { raw: body, gz: zlib.gzipSync(body, { level: 6 }) };
  }
  return dataset;
}

function buildRankingsPayload(dataset, records) {
  return {
    records,
    categories: dataset.categories,
    years: dataset.years,
    states: dataset.states,
    metadata: dataset.metadata,
    dataAvailable: dataset.loaded && records.length > 0,
    count: records.length,
  };
}

let cache = { mtimeMs: -1, size: -1, dataset: emptyDataset("No prepared official dataset found. Run scripts/collect_nirf.py first.") };

function readDataset() {
  let stat;
  try {
    stat = fs.statSync(DATA_FILE);
  } catch {
    if (cache.mtimeMs !== -2) {
      cache = { mtimeMs: -2, size: -2, dataset: emptyDataset("No prepared official dataset found. Run scripts/collect_nirf.py first.") };
    }
    return cache.dataset;
  }
  if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.dataset;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, dataset: buildDataset(parsed) };
  } catch (error) {
    console.error(`Could not read ${DATA_FILE}: ${error.message}`);
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, dataset: emptyDataset("The prepared dataset could not be read. Re-run scripts/collect_nirf.py.") };
  }
  return cache.dataset;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  const dataset = readDataset();
  res.json({
    status: "ok",
    service: "NIRF Insight API",
    timestamp: new Date().toISOString(),
    dataset: {
      loaded: dataset.loaded,
      records: dataset.records.length,
      years: dataset.years,
      generatedAt: dataset.metadata.generated_at ?? null,
    },
  });
});

function queryText(value) {
  return (Array.isArray(value) ? value[0] : value ?? "").toString().trim().toLowerCase();
}

app.get("/api/rankings", (req, res) => {
  const dataset = readDataset();
  const rawYear = Array.isArray(req.query.year) ? req.query.year[0] : req.query.year;
  let year = null;
  if (rawYear !== undefined && rawYear !== "") {
    year = Number(rawYear);
    if (!Number.isInteger(year)) return res.status(400).json({ error: `Invalid year "${rawYear}". Use a four-digit year such as 2025.` });
  }
  const category = queryText(req.query.category);
  const state = queryText(req.query.state);
  const search = queryText(req.query.search);
  const unfiltered = year === null && (!category || category === "all categories") && (!state || state === "all states") && !search;

  if (unfiltered && dataset.gzip) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Vary", "Accept-Encoding");
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
      res.setHeader("Content-Encoding", "gzip");
      return res.send(dataset.gzip.gz);
    }
    return res.send(dataset.gzip.raw);
  }

  const records = dataset.records.filter((row) => {
    if (year !== null && row.year !== year) return false;
    if (category && category !== "all categories" && row.category.toLowerCase() !== category) return false;
    if (state && state !== "all states" && row.state.toLowerCase() !== state) return false;
    if (search && !`${row.institution} ${row.institution_published_name} ${row.state} ${row.city} ${row.institution_id_original}`.toLowerCase().includes(search)) return false;
    return true;
  });
  res.json(buildRankingsPayload(dataset, records));
});

app.get("/api/rankings/meta", (_req, res) => {
  const dataset = readDataset();
  let audit = null;
  try {
    audit = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8"));
  } catch {
    // The audit report is created by the preparation pipeline.
  }
  res.json({
    metadata: dataset.metadata,
    categories: dataset.categories,
    years: dataset.years,
    audit,
    dataAvailable: dataset.loaded,
  });
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fmt = (value, digits = 2) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value).toFixed(digits) : null);

app.post("/api/copilot", (req, res) => {
  const body = isObject(req.body) ? req.body : {};
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const context = isObject(body.context) ? body.context : {};
  if (!query) return res.status(400).json({ error: "Please provide a question." });
  if (query.length > 500) return res.status(400).json({ error: "Please keep the question under 500 characters." });

  const question = query.toLowerCase();
  const source = typeof context.source === "string" && context.source ? context.source : "prepared NIRF dataset";
  const year = context.year ?? "the selected year";
  const selected = isObject(context.selected) ? context.selected : null;
  const trend = Array.isArray(context.trend) ? context.trend.filter((p) => isObject(p) && Number.isFinite(Number(p.year))) : [];
  let answer;

  if (!context.dataAvailable) {
    answer = "No prepared NIRF dataset is loaded yet. Run the data collection and preparation pipeline, then refresh the dashboard.";
  } else if (/\b(state|states|geograph\w*|region\w*)\b/.test(question)) {
    const leadingState = Array.isArray(context.stateData) ? context.stateData[0] : null;
    answer = leadingState && leadingState.state
      ? `In the ${year} records for the selected filters, ${leadingState.state} has the highest representation, with ${leadingState.count} ranked institutions. This describes the selected dataset, not the entire NIRF universe.`
      : "No state representation data is available for the current filters.";
  } else if (/\b(research|rpc|correlat\w*|relationship|together)\b/.test(question)) {
    const r = Number(context.correlation);
    const strength = Math.abs(r) > 0.7 ? "strong" : Math.abs(r) > 0.3 ? "moderate" : "weak";
    answer = context.correlationAvailable && Number.isFinite(r)
      ? `${context.xLabel ?? "The selected parameter"} and ${context.yLabel ?? "overall score"} show a ${strength} ${r >= 0 ? "positive" : "negative"} correlation (r = ${r.toFixed(2)}) in ${year}, based on records where both values are published.`
      : "Correlation cannot be calculated reliably because the selected parameter values are missing or constant in the prepared records.";
  } else if (/\b(trend|improv\w*|progress\w*|history|over time|change\w*)\b/.test(question)) {
    const scored = trend.filter((p) => Number.isFinite(Number(p.score))).sort((a, b) => a.year - b.year);
    if (!context.institution) {
      answer = "No institution is available for the current selection.";
    } else if (scored.length > 1) {
      const first = scored[0];
      const last = scored[scored.length - 1];
      const delta = Number(last.score) - Number(first.score);
      answer = `${context.institution}'s published score went from ${fmt(first.score)} in ${first.year} to ${fmt(last.score)} in ${last.year} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} points) across ${scored.length} ranked years in this category. Scoring methodology changed over the years, so treat long-run comparisons with care.`;
    } else if (scored.length === 1) {
      answer = `${context.institution} has only one published score in this category (${fmt(scored[0].score)} in ${scored[0].year}), so no trend can be computed.`;
    } else {
      answer = `${context.institution} has no published score history in this category in the prepared records.`;
    }
  } else if (/\b(rank|ranked|position|score)\b/.test(question) && selected && context.institution) {
    const rank = selected.rankLabel ? `of ${selected.rankLabel}` : Number.isFinite(Number(selected.rank)) && selected.rank !== null ? `of #${selected.rank}` : "that is not available as an exact number";
    const score = fmt(selected.score) ? `a score of ${fmt(selected.score)}` : "no published score in this record";
    answer = `${context.institution} has a published rank ${rank} and ${score} for ${year}.${selected.sourceUrl ? ` Source: ${selected.sourceUrl}.` : ""}`;
  } else {
    const count = Number.isFinite(Number(context.recordCount)) ? Number(context.recordCount) : 0;
    answer = `For ${year}, the selected official records contain ${count} ranked institutions. Their average score is ${context.averageScore ?? "unavailable"} and the median is ${context.medianScore ?? "unavailable"}. Source: ${source}.`;
  }
  res.json({ answer, source, mode: "rule-based", dataAvailable: Boolean(context.dataAvailable) });
});

// ---------------------------------------------------------------------------
// Fallbacks. Every error is returned as JSON so the frontend can display it.
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) console.error(error);
  const message = error?.type === "entity.parse.failed" ? "Request body is not valid JSON." : status >= 500 ? "Internal server error." : error.message;
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, () => {
  console.log(`NIRF Insight API running at http://localhost:${PORT}`);
  const dataset = readDataset();
  if (!dataset.loaded) console.warn("No prepared NIRF dataset found yet. Run: python scripts/collect_nirf.py");
  else console.log(`Loaded ${dataset.records.length.toLocaleString()} records (${dataset.years[0]}–${dataset.years.at(-1)}).`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`);
  else console.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
