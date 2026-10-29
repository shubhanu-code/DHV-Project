#!/usr/bin/env python3
"""Collect and normalize published NIRF ranking tables for 2017-2025.

Official source pages are retained verbatim (as raw bytes) under data/raw. The
script does not invent rows: unavailable pages and parse failures are written
to the audit report.

Usage:
    python collect_nirf_rankings.py                      # fetch + prepare 2017-2025
    python collect_nirf_rankings.py --years 2023-2025    # a range
    python collect_nirf_rankings.py --years 2024         # a single year
    python collect_nirf_rankings.py --prepare-only       # parse saved HTML only
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from bs4.element import Comment
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.nirfindia.org"
MIN_YEAR, MAX_YEAR = 2017, 2025
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NIRFInsightResearch/1.0; educational data preparation)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

# Fallbacks are only used if a year's official landing page cannot be parsed.
# They are candidates, not a claim that every category existed in every year.
FALLBACK_CATEGORIES = [
    ("Overall", "OverallRanking.html"),
    ("Universities", "UniversityRanking.html"),
    ("Colleges", "CollegeRanking.html"),
    ("Research Institutions", "ResearchRanking.html"),
    ("Engineering", "EngineeringRanking.html"),
    ("Management", "ManagementRanking.html"),
    ("Pharmacy", "PharmacyRanking.html"),
    ("Medical", "MedicalRanking.html"),
    ("Dental", "DentalRanking.html"),
    ("Law", "LawRanking.html"),
    ("Architecture and Planning", "ArchitectureRanking.html"),
    ("Agriculture and Allied Sectors", "AgricultureRanking.html"),
    ("Innovation", "InnovationRanking.html"),
    ("Open Universities", "OpenUniversityRanking.html"),
    ("Skill Universities", "SkillUniversityRanking.html"),
    ("State Public Universities", "StatePublicUniversityRanking.html"),
    ("Sustainable Development Goals (SDGs)", "SDGRanking.html"),
]

# Keys are lower-case, "&" already rewritten to "and", year and "ranking" removed.
CATEGORY_ALIASES = {
    "overall": "Overall",
    "university": "University", "universities": "University",
    "college": "College", "colleges": "College",
    "research institution": "Research Institution", "research institutions": "Research Institution",
    "research": "Research Institution",
    "engineering": "Engineering", "management": "Management", "pharmacy": "Pharmacy",
    "medical": "Medical", "dental": "Dental", "law": "Law",
    "architecture": "Architecture & Planning", "architecture and planning": "Architecture & Planning",
    "agriculture": "Agriculture & Allied Sectors", "agriculture and allied sectors": "Agriculture & Allied Sectors",
    "innovation": "Innovation",
    "open university": "Open University", "open universities": "Open University",
    "skill university": "Skill University", "skill universities": "Skill University",
    "state public university": "State Public University", "state public universities": "State Public University",
    "sustainable development goals (sdgs)": "Sustainable Development Goals (SDGs)",
    "sdg": "Sustainable Development Goals (SDGs)", "sdgs": "Sustainable Development Goals (SDGs)",
}
STATE_ALIASES = {
    "pondicherry": "Puducherry", "orissa": "Odisha", "uttaranchal": "Uttarakhand",
    "nct of delhi": "Delhi", "new delhi": "Delhi",
    "jammu & kashmir": "Jammu and Kashmir", "jammu and kashmir": "Jammu and Kashmir",
    "andaman & nicobar islands": "Andaman and Nicobar Islands",
    "andaman and nicobar islands": "Andaman and Nicobar Islands",
}

IR_ID = re.compile(r"\bIR-[A-Z0-9-]+\b", re.I)
# A rank cell is a number ("12"), a suffixed tie label ("16A"), or a band ("101-150", "201+"). Anything else is not a rank row.
RANK_RE = re.compile(r"^\d{1,4}[A-Za-z]?(?:\s*[-\u2013]\s*\d{1,4}|\+)?$")
PARAM_ORDER = ("tlr", "rpc", "go", "oi", "perception")
PARAM_LABELS = {"tlr": r"TLR", "rpc": r"RPC", "go": r"GO", "oi": r"OI",
                "perception": r"(?:PERCEPTION|PERCEPT|PR|PER)"}
NUM = r"(\d+(?:\.\d+)?)"
CSV_COLUMNS = [
    "year", "year_original", "category_original", "category_standard", "institution_id_original",
    "institution_name_original", "institution_name_standard", "city_original",
    "state_original", "state_standard", "rank", "rank_label", "score", "score_original",
    "tlr", "rpc", "go", "oi", "perception", "source_url", "record_prepared_at",
    "record_status", "parse_notes",
]
PARSED_STATES = {"parsed", "saved_but_no_records_parsed"}


# --------------------------------------------------------------------------- #
# Text normalisation helpers
# --------------------------------------------------------------------------- #
def clean_text(value: str | None) -> str:
    value = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"\s+", " ", value).strip()


def standard_name(value: str | None) -> str:
    value = clean_text(value)
    # Drop any parameter-detail text that leaked into the name cell.
    value = re.split(r"\bTLR\s*\(", value, maxsplit=1, flags=re.I)[0]
    # Everything from the "More Details" toggle onwards is UI chrome ("More Details Close | Close |").
    value = re.split(r"\bMore\s+Details\b", value, maxsplit=1, flags=re.I)[0]
    value = re.sub(r"(?:\s*(?:\||\bClose\b))+\s*$", "", value, flags=re.I)
    return clean_text(value.strip(" |"))


def normalize_category(value: str) -> str:
    original = clean_text(value)
    key = original.lower().replace("&amp;", "&")
    key = re.sub(r"\b(?:19|20)\d{2}\b", " ", key)
    key = re.sub(r"\branking[s]?\b", " ", key)
    key = clean_text(key).strip(" -:")
    key = key.replace(" & ", " and ")
    return CATEGORY_ALIASES.get(key, original)


def normalize_state(value: str) -> str:
    value = clean_text(value)
    key = value.lower()
    if key in STATE_ALIASES:
        return STATE_ALIASES[key]
    # Source pages sometimes publish states in upper case ("TAMIL NADU"); title-case those.
    if value.isupper():
        value = " ".join(w if w.lower() in {"and", "of"} else w.capitalize() for w in value.lower().split())
        return STATE_ALIASES.get(value.lower(), value)
    return value


def numeric(value: str | None) -> float | None:
    value = clean_text(value)
    if not value or value.lower() in {"-", "\u2014", "na", "n/a", "nil", "none"}:
        return None
    match = re.search(r"-?\d+(?:,\d{3})*(?:\.\d+)?", value)
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def rank_value(value: str | None) -> tuple[int | None, str]:
    """Return (first number, original label). Only strict rank/band labels are accepted."""
    label = clean_text(value)
    if not label or not RANK_RE.match(label.replace(",", "")):
        return None, label
    return int(re.search(r"\d+", label.replace(",", "")).group(0)), label


# --------------------------------------------------------------------------- #
# Discovery and fetching
# --------------------------------------------------------------------------- #
def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=1.0, status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=("GET",), respect_retry_after_header=True, raise_on_status=False)
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(HEADERS)
    return session


def year_bases(year: int) -> list[str]:
    # Every successful fetch in the 2017-2025 audit used /Rankings/<year>/; the older /<year>/ layout only 404'd.
    return [f"{BASE}/Rankings/{year}"]


def is_html_response(response: requests.Response) -> bool:
    ctype = response.headers.get("content-type", "").lower()
    return response.status_code == 200 and (not ctype or "html" in ctype)


def local_relpath(year: int, url: str) -> Path:
    """Local path (relative to data/raw/<year>) for a source URL, without traversal."""
    path = PurePosixPath(urlparse(url).path)
    parts = [p for p in path.parts if p not in ("/", "", ".", "..")]
    ys = str(year)
    if ys in parts:
        parts = parts[parts.index(ys) + 1:]
    if not parts:
        parts = [path.name or "index.html"]
    return Path(*parts)


def extract_category_links(content: bytes | str, page_url: str, year: int) -> list[dict]:
    soup = BeautifulSoup(content, "html.parser")
    found: dict[str, dict] = {}
    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href", "").strip()
        label = clean_text(anchor.get_text(" ", strip=True))
        if not label or not href or href.lower().startswith(("javascript:", "mailto:", "#")):
            continue
        absolute = urljoin(page_url, href).split("#")[0]
        parsed = urlparse(absolute)
        if not parsed.netloc.lower().endswith("nirfindia.org"):
            continue
        filename = PurePosixPath(parsed.path).name
        if not filename.lower().endswith(".html") or "ranking" not in filename.lower():
            continue
        if str(year) not in parsed.path:
            continue
        # Avoid report and landing links; accept category-specific ranking tables.
        if filename.lower() in {"ranking.html", f"ranking{year}.html"}:
            continue
        if any(word in label.lower() for word in ("methodology", "report", "faq")):
            continue
        found.setdefault(absolute, {"category_original": label,
                                    "category_standard": normalize_category(label), "url": absolute})
    return sorted(found.values(), key=lambda item: (item["category_standard"].lower(), item["url"]))


def discover_categories(session: requests.Session, year: int, raw_dir: Path, delay: float, audit: dict) -> list[dict]:
    year_dir = raw_dir / str(year)
    for base in year_bases(year):
        for url in (f"{base}/Ranking{year}.html", f"{base}/Ranking.html"):
            try:
                response = session.get(url, timeout=30)
            except requests.RequestException as exc:
                audit["collection_errors"].append({"year": year, "url": url, "stage": "landing", "error": str(exc)})
                time.sleep(max(0.0, delay))
                continue
            time.sleep(max(0.0, delay))
            if not is_html_response(response):
                audit["collection_errors"].append({"year": year, "url": url, "stage": "landing",
                                                   "error": f"HTTP {response.status_code}"})
                continue
            year_dir.mkdir(parents=True, exist_ok=True)
            (year_dir / "_landing.html").write_bytes(response.content)   # verbatim bytes, kept even if unparsable
            (year_dir / "_landing.url").write_text(url, encoding="utf-8")  # base for relative links
            links = extract_category_links(response.content, url, year)
            if not links:
                audit["parse_warnings"].append({"year": year, "url": url, "stage": "landing_parse",
                                                "warning": "Landing page saved (see _landing.html) but no category links parsed; "
                                                           "falling back to candidate category URLs."})
                continue
            return links
    # Candidate URLs are validated by HTTP response later; they are not assumed to exist.
    return [{"category_original": label, "category_standard": normalize_category(label),
             "url": f"{base}/{slug}"}
            for base in year_bases(year) for label, slug in FALLBACK_CATEGORIES]


def collect(selected_years: list[int], raw_dir: Path, root: Path, delay: float, audit: dict) -> None:
    session = make_session()
    for year in selected_years:
        done: set[Path] = set()
        for category in discover_categories(session, year, raw_dir, delay, audit):
            url = category["url"]
            rel = local_relpath(year, url)
            if rel in done or not rel.name.lower().endswith(".html") or rel.name.startswith("_"):
                continue
            target = raw_dir / str(year) / rel
            entry = {"year": year, **category}
            if target.exists() and target.stat().st_size > 1000:
                audit["category_registry"].append({**entry, "local_file": target.relative_to(root).as_posix(),
                                                   "availability": "cached_source_html"})
                done.add(rel)
                continue
            try:
                response = session.get(url, timeout=30)
                if not is_html_response(response):
                    audit["collection_errors"].append({"year": year, "category": category["category_original"],
                                                       "url": url, "stage": "category",
                                                       "error": f"HTTP {response.status_code}"})
                    audit["category_registry"].append({**entry, "availability": f"http_{response.status_code}",
                                                       "record_count": 0})
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(response.content)  # verbatim bytes; encoding resolved at parse time
                    audit["category_registry"].append({**entry, "local_file": target.relative_to(root).as_posix(),
                                                       "availability": "fetched_source_html"})
                    done.add(rel)
            except requests.RequestException as exc:
                audit["collection_errors"].append({"year": year, "category": category["category_original"],
                                                   "url": url, "stage": "category", "error": str(exc)})
                audit["category_registry"].append({**entry, "availability": "request_error",
                                                   "error": str(exc), "record_count": 0})
            time.sleep(max(0.0, delay))


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def own_rows(table) -> list:
    """Rows that belong to this table, excluding rows of nested tables."""
    return [tr for tr in table.find_all("tr") if tr.find_parent("table") is table]


def own_text(cell) -> str:
    """Cell text excluding anything inside nested tables (e.g. the 'More Details' panel)."""
    owner = cell.find_parent("table")
    parts = []
    for node in cell.find_all(string=True):
        if isinstance(node, Comment) or node.parent.name in {"script", "style"}:
            continue
        if node.find_parent("table") is not owner:
            continue
        parts.append(str(node))
    return clean_text(" ".join(parts))


def map_header(texts: list[str]) -> dict[str, int] | None:
    mapping: dict[str, int] = {}
    for index, text in enumerate(texts):
        label = text.lower().strip()
        if re.fullmatch(r"(?:institute|institution)?\s*id", label):
            key = "id"
        elif "name" in label:
            key = "name"
        elif label == "city":
            key = "city"
        elif label == "state":
            key = "state"
        elif label in {"score", "total score"}:   # not "TLR Score", "RPC Score", ... (parameter views)
            key = "score"
        elif label.startswith("rank") or label == "band":   # "Band" is the rank column on Innovation pages
            key = "rank"
        else:
            continue
        mapping.setdefault(key, index)
    return mapping if {"name", "rank"} <= mapping.keys() else None


def parse_parameter_scores(text: str) -> dict[str, float | None]:
    """Extract TLR/RPC/GO/OI/Perception from published detail text, else leave None.

    Handles both layouts: 'TLR (100) 75.2 RPC (100) 60.1 ...' and a label row
    followed by a value row. Nothing is guessed when neither matches.
    """
    text = clean_text(text)
    empty: dict[str, float | None] = {key: None for key in PARAM_ORDER}

    def labelled(key: str) -> str:
        return rf"\b{PARAM_LABELS[key]}\s*\(\s*100\s*\)"

    header_run = r"\s*".join(labelled(key) for key in PARAM_ORDER)
    if re.search(header_run, text, re.I):
        # Label row followed by a value row.
        match = re.search(header_run + r"\s*" + r"\s+".join(NUM for _ in PARAM_ORDER), text, re.I)
        values = [float(v) for v in match.groups()] if match else []
    else:
        values = []
        for key in PARAM_ORDER:
            match = re.search(labelled(key) + r"\s*[:=]?\s*" + NUM, text, re.I)
            if not match:
                return empty
            values.append(float(match.group(1)))
    if len(values) != len(PARAM_ORDER) or any(v > 100 for v in values):
        return empty
    return dict(zip(PARAM_ORDER, values))


def parse_ranking_html(content: bytes | str, year: int, category_original: str, category_standard: str,
                       url: str, prepared_at: str, warnings: list | None = None) -> list[dict]:
    soup = BeautifulSoup(content, "html.parser")
    records: list[dict] = []
    positional_rows = 0  # accepted records that relied on positional columns
    for table in soup.find_all("table"):
        rows = own_rows(table)
        header_map: dict[str, int] | None = None
        for row_index, tr in enumerate(rows):
            cells = tr.find_all(["td", "th"], recursive=False)
            if not cells:
                continue
            texts = [own_text(cell) for cell in cells]
            maybe_header = map_header(texts)
            if maybe_header:
                header_map = maybe_header
                continue
            positional = header_map is None
            if header_map:
                if len(cells) < max(header_map.values()) + 1:
                    continue

                def get(key: str, _texts=texts, _map=header_map) -> str:
                    return _texts[_map[key]] if key in _map else ""

                id_match = IR_ID.search(get("id")) or IR_ID.search(" ".join(texts))
                name_original = get("name")
                city, state = get("city"), get("state")
                score_text, rank_text = get("score"), get("rank")
            else:
                if len(texts) < 5:
                    continue
                id_idx = next((i for i, text in enumerate(texts) if IR_ID.search(text)), None)
                id_match = IR_ID.search(texts[id_idx]) if id_idx is not None else None
                name_idx = id_idx + 1 if id_idx is not None else (1 if len(texts) >= 6 else 0)
                if name_idx >= len(texts):
                    continue
                name_original = texts[name_idx]
                city = texts[name_idx + 1] if len(texts) >= 6 and name_idx + 1 < len(texts) else ""
                state = texts[name_idx + 2] if len(texts) >= 6 and name_idx + 2 < len(texts) else ""
                score_text, rank_text = texts[-2], texts[-1]
            if id_match:
                institution_id = id_match.group(0).upper()
            else:
                institution_id = get("id") if header_map else ""   # keep the published ID even if its format differs
            name_standard = standard_name(name_original)
            if (len(name_standard) < 3 or not re.search(r"[A-Za-z]", name_standard)
                    or name_standard.lower() in {"name", "institute", "institution", "institute name"}):
                continue
            rank, rank_label = rank_value(rank_text)
            withdrawn = rank is None and bool(re.search(r"withdrawn", rank_label, re.I))
            if rank is None and not withdrawn:   # header, detail, footnote or nested-table rows
                continue
            score = numeric(score_text)
            # Parameter scores live in the row's hidden detail panel (nested table) or in
            # immediately following non-data rows. Otherwise they stay missing.
            detail_parts = [tr.get_text(" ", strip=True)]
            for sibling in rows[row_index + 1:row_index + 3]:
                if len(sibling.find_all(["td", "th"], recursive=False)) >= 5:
                    break  # next data row; never borrow its details
                detail_parts.append(sibling.get_text(" ", strip=True))
            parameter_scores = parse_parameter_scores(" ".join(detail_parts))
            positional_rows += positional
            records.append({
                "year": year,
                "year_original": str(year),
                "category_original": category_original,
                "category_standard": category_standard,
                "institution_id_original": institution_id,
                "institution_name_original": name_original,
                "institution_name_standard": name_standard,
                "city_original": city,
                "state_original": state,
                "state_standard": normalize_state(state),
                "rank": rank,
                "rank_label": rank_label,
                "score": score,
                "score_original": score_text,
                **parameter_scores,
                "source_url": url,
                "record_prepared_at": prepared_at,
                "record_status": "rank_withdrawn" if withdrawn else "published_rank_row",
                "parse_notes": "Parameter scores parsed from the row's detail panel when the published labels and values matched; otherwise left missing.",
            })
    if warnings is not None and positional_rows:
        warnings.append({"year": year, "category": category_original, "url": url,
                         "warning": f"{positional_rows} row(s) parsed with positional columns (no recognised header row)."})
    # Duplicates are removed (and counted) at the integration stage.
    return records


# --------------------------------------------------------------------------- #
# Integration
# --------------------------------------------------------------------------- #
def saved_categories(year: int, year_dir: Path) -> list[tuple[Path, dict]]:
    """Categories whose HTML exists locally, de-duplicated by local file."""
    found: dict[Path, dict] = {}
    landing = year_dir / "_landing.html"
    if landing.exists():
        url_file = year_dir / "_landing.url"
        page_url = url_file.read_text(encoding="utf-8").strip() if url_file.exists() \
            else f"{BASE}/Rankings/{year}/Ranking.html"
        for category in extract_category_links(landing.read_bytes(), page_url, year):
            rel = local_relpath(year, category["url"])
            if (year_dir / rel).is_file():
                found.setdefault(rel, category)
    for label, slug in FALLBACK_CATEGORIES:
        rel = Path(slug)
        if (year_dir / rel).is_file():
            found.setdefault(rel, {"category_original": label, "category_standard": normalize_category(label),
                                   "url": f"{BASE}/Rankings/{year}/{slug}"})
    return sorted(found.items(), key=lambda item: item[0].as_posix())


def prepare_from_saved_html(selected_years: list[int], raw_dir: Path, root: Path,
                            prepared_at: str, audit: dict) -> tuple[list[dict], list[dict]]:
    records: list[dict] = []
    registry: list[dict] = []
    for year in selected_years:
        year_dir = raw_dir / str(year)
        for rel, category in saved_categories(year, year_dir):
            path = year_dir / rel
            page_records = parse_ranking_html(path.read_bytes(), year, category["category_original"],
                                              category["category_standard"], category["url"],
                                              prepared_at, audit["parse_warnings"])
            records.extend(page_records)
            if not page_records:
                audit["parse_warnings"].append({"year": year, "category": category["category_original"],
                                                "url": category["url"],
                                                "warning": "Page saved but no ranking rows were parsed."})
            registry.append({"year": year, **category, "local_file": path.relative_to(root).as_posix(),
                             "record_count": len(page_records),
                             "availability": "parsed" if page_records else "saved_but_no_records_parsed"})
    return records, registry


def merge_registries(parsed: list[dict], fetched: list[dict], selected_years: list[int]) -> list[dict]:
    def key_of(entry: dict):
        return (entry.get("year"), entry.get("local_file") or entry.get("url"))

    merged = {key_of(entry): entry for entry in parsed}
    for entry in fetched:
        if entry.get("year") not in selected_years:
            continue
        key = key_of(entry)
        if key in merged:
            previous = merged[key]
            entry = {**entry, "record_count": previous.get("record_count", 0),
                     "local_file": previous.get("local_file", entry.get("local_file"))}
            entry["availability"] = "parsed" if entry["record_count"] > 0 else "saved_but_no_records_parsed"
        else:
            entry = {**entry, "record_count": entry.get("record_count", 0)}
        merged[key] = entry
    return sorted(merged.values(), key=lambda e: (e.get("year", 0), e.get("category_standard", ""), e.get("url", "")))


def deduplicate(records: list[dict]) -> tuple[list[dict], int, Counter]:
    unique: dict[tuple, dict] = {}
    duplicates = 0
    per_category: Counter = Counter()
    for record in records:
        identity = (record["year"], record["category_standard"],
                    record["institution_id_original"] or record["institution_name_standard"], record["rank_label"])
        if identity in unique:
            duplicates += 1
            per_category[(record["year"], record["category_standard"])] += 1
        else:
            unique[identity] = record
    ordered = sorted(unique.values(), key=lambda r: (r["year"], r["category_standard"],
                                                     r["rank"] if r["rank"] is not None else 10 ** 9,
                                                     r["institution_name_standard"].lower()))
    return ordered, duplicates, per_category


def rank_diagnostics(records: list[dict]) -> dict[tuple, dict]:
    """Per (year, category) rank-sequence checks.

    NIRF uses standard competition ranking: n institutions tied at rank r are followed by rank r+n, so
    r+1..r+n-1 are expected gaps. 'Rank Withdrawn' rows keep their row but have no rank. Anything left
    in unexplained_missing_ranks (beyond withdrawn_rows) deserves a look at the source page.
    """
    exact: dict[tuple, list[int]] = {}
    withdrawn: Counter = Counter()
    for record in records:
        key = (record["year"], record["category_standard"])
        if record["record_status"] == "rank_withdrawn":
            withdrawn[key] += 1
        elif re.fullmatch(r"\d+", record["rank_label"].replace(",", "")):
            exact.setdefault(key, []).append(record["rank"])
    result = {}
    for key, ranks in exact.items():
        counts = Counter(ranks)
        present = set(ranks)
        missing = [r for r in range(1, max(ranks) + 1) if r not in present]
        tie_gaps = {r + k for r, n in counts.items() if n > 1 for k in range(1, n)}
        result[key] = {"missing_exact_ranks": missing,
                       "tied_exact_ranks": sorted(r for r, n in counts.items() if n > 1),
                       "withdrawn_rows": withdrawn[key],
                       "unexplained_missing_ranks": [m for m in missing if m not in tie_gaps]}
    return result


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def write_csv(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def parse_year_range(text: str) -> list[int]:
    parts = [part.strip() for part in text.split("-")]
    if len(parts) == 1:
        start = end = int(parts[0])
    elif len(parts) == 2:
        start, end = int(parts[0]), int(parts[1])
    else:
        raise ValueError
    if start < MIN_YEAR or end > MAX_YEAR or start > end:
        raise ValueError
    return list(range(start, end + 1))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--years", default=f"{MIN_YEAR}-{MAX_YEAR}", help="Year or range, e.g. 2023 or 2017-2025")
    parser.add_argument("--delay", type=float, default=0.35, help="Delay between source requests in seconds")
    parser.add_argument("--prepare-only", action="store_true", help="Prepare from HTML already saved in data/raw")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="Project root containing data/ (default: parent of scripts/)")
    args = parser.parse_args(argv)
    try:
        selected_years = parse_year_range(args.years)
    except ValueError:
        parser.error(f"--years must be a year or range within {MIN_YEAR}-{MAX_YEAR}")

    root = args.root.resolve()
    raw_dir = root / "data" / "raw"
    processed_dir = root / "data" / "processed"
    raw_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)

    generated_at = datetime.now(timezone.utc).isoformat()
    audit: dict = {
        "generated_at": generated_at,
        "scope": {"years_requested": selected_years, "official_source_domain": "nirfindia.org"},
        "collection_errors": [], "parse_warnings": [], "category_registry": [], "duplicate_rows_removed": 0,
        "missing_value_counts": {}, "records_by_year_category": [],
        "notes": [
            "The raw HTML archive is retained (byte-for-byte) for reproducibility.",
            "A missing category is not imputed as zero and is not assumed to have existed in every year.",
            "Parameter scores remain null unless they are extracted from a supported source-table schema.",
            "Rows published as 'Rank Withdrawn' are kept with rank = null and record_status = rank_withdrawn; exclude them from rank-based analysis.",
            "Ranking pages repeat the table (full score plus per-parameter views), so large duplicates_removed counts are expected.",
            "Rank bands preserve rank_label; rank stores only the first numeric value for convenience and must not be treated as an exact rank for a band.",
            "HTTP 404 responses for candidate category URLs are expected for categories that did not exist in a given year.",
        ],
    }
    if not args.prepare_only:
        collect(selected_years, raw_dir, root, args.delay, audit)

    parsed_records, parsed_registry = prepare_from_saved_html(selected_years, raw_dir, root, generated_at, audit)
    registry = merge_registries(parsed_registry, audit["category_registry"], selected_years)
    records, duplicate_count, duplicates_by_category = deduplicate([r for r in parsed_records if r["year"] in selected_years])
    diagnostics = rank_diagnostics(records)

    audit["category_registry"] = registry
    audit["duplicate_rows_removed"] = duplicate_count
    fields = ["institution_id_original", "institution_name_original", "state_original", "city_original",
              "rank", "rank_label", "score", "tlr", "rpc", "go", "oi", "perception"]
    audit["missing_value_counts"] = {f: sum(record.get(f) in (None, "") for record in records) for f in fields}
    counts = Counter((record["year"], record["category_standard"]) for record in records)
    audit["records_by_year_category"] = [
        {"year": y, "category_standard": c, "record_count": n,
         "duplicates_removed": duplicates_by_category.get((y, c), 0),
         **diagnostics.get((y, c), {"missing_exact_ranks": [], "tied_exact_ranks": [],
                                   "withdrawn_rows": 0, "unexplained_missing_ranks": []})}
        for (y, c), n in sorted(counts.items())]
    audit["total_records"] = len(records)
    audit["years_with_records"] = sorted({record["year"] for record in records})
    audit["years_without_records"] = sorted(set(selected_years) - set(audit["years_with_records"]))
    audit["registry_entries"] = len(registry)
    audit["collection_error_count"] = len(audit["collection_errors"])

    # 404s on speculative category URLs are normal; anything else (blocks, timeouts, 5xx,
    # unparseable pages, years with no rows) means the dataset may be incomplete.
    serious_errors = [e for e in audit["collection_errors"] if e.get("error") != "HTTP 404"]
    unparsed_pages = [e for e in registry if e.get("availability") == "saved_but_no_records_parsed"]
    is_complete = bool(records) and not audit["years_without_records"] and not serious_errors and not unparsed_pages
    audit["is_complete"] = is_complete

    write_csv(processed_dir / "rankings.csv", records)
    save_json(processed_dir / "rankings.json", {
        "metadata": {
            "title": "NIRF published rankings, prepared dataset",
            "years_requested": selected_years,
            "years_with_records": audit["years_with_records"],
            "total_records": len(records),
            "source": "National Institutional Ranking Framework, Ministry of Education, Government of India",
            "source_domain": "nirfindia.org",
            "generated_at": generated_at,
            "is_complete": is_complete,
            "data_notice": "Records are only included when parsed from retained official NIRF HTML. Review audit_report.json before interpreting historical comparisons.",
        },
        "categories": sorted(
            {record["category_standard"] for record in records}
            | {e["category_standard"] for e in registry
               if e.get("category_standard") and e.get("availability") in PARSED_STATES}
        ),
        "years": selected_years,
        "records": records,
    })
    save_json(processed_dir / "category_registry.json", {
        "years_requested": selected_years,
        "categories": registry,
        "standardization_note": "category_original is preserved; category_standard is for grouping only. Availability is year-specific.",
    })
    save_json(processed_dir / "audit_report.json", audit)

    print(f"Prepared {len(records):,} ranking records across {len(audit['years_with_records'])} year(s).")
    print(f"CSV: {processed_dir / 'rankings.csv'}")
    print(f"JSON: {processed_dir / 'rankings.json'}")
    print(f"Audit: {processed_dir / 'audit_report.json'}")
    if serious_errors:
        print(f"WARNING: {len(serious_errors)} source collection issue(s) besides expected 404s; inspect audit_report.json.",
              file=sys.stderr)
    if audit["parse_warnings"]:
        print(f"WARNING: {len(audit['parse_warnings'])} parse warning(s); inspect audit_report.json.", file=sys.stderr)
    if not records:
        print("No ranking rows were parsed. NIRF may have blocked requests, page schemas may have changed, "
              "or source pages may be unavailable. Do not treat the empty output as zero rankings.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())