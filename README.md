# NIRF Insight

NIRF Insight is a React/Vite dashboard with an Express API and a reproducible Python pipeline for collecting and preparing published National Institutional Ranking Framework (NIRF) rankings from 2017–2025.

## What the pipeline does

- Discovers category ranking pages from the official yearly NIRF landing pages, with candidate URLs used only as a fallback.
- Saves fetched HTML verbatim under `data/raw/<year>/` for provenance and repeatable parsing.
- Preserves original institution names, state names, category labels, score text and rank labels alongside normalized fields.
- Creates `data/processed/rankings.csv`, `rankings.json`, `category_registry.json`, and `audit_report.json`.
- Tracks year/category availability, parse/collection errors, missing values and duplicate records. It does not impute unavailable categories as zero.
- Keeps rank bands (for example, `101–150`) in `rank_label`; the numeric `rank` field must not be interpreted as an exact rank for a band.

## 1. Prepare the data

Use Python 3.10 or newer (the frontend needs Node.js 20.19+ or 22.12+). From the project root in PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r scripts\requirements.txt
python scripts\collect_nirf.py --years 2017-2025
```

NIRF may rate-limit or block automated requests. If a source page fails, inspect `data/processed/audit_report.json`. The script will report gaps rather than invent ranking records. Run the offline parser tests with `python -m unittest discover -s scripts -p "test_*.py" -v`. If you have already saved official HTML pages into `data/raw/<year>/`, re-run preparation without fetching:

```powershell
python scripts\collect_nirf.py --years 2017-2025 --prepare-only
```

**Important:** the collector's output must be reviewed before analysis. Check category coverage, missing values and parse warnings in `audit_report.json`. Historical category availability and methodologies changed over time; compare only compatible categories and fields. Parameter values remain missing unless extracted from a source table schema, rather than being estimated.

## 2. Start the application

Terminal 1 — backend:

```powershell
cd backend
npm install
npm run dev
```

Terminal 2 — chatbot API, from the project root:

```powershell
cd chat-Bot
python -m pip install -r requirements.txt
python -m uvicorn nirf_chatbot.main:app --app-dir src --reload --port 8000
```

Terminal 3 — frontend, from the project root:

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal. The frontend uses `/api/rankings` to load prepared records and sends chatbot questions to the FastAPI service. If the data pipeline has not produced a dataset, the dashboard displays a notice instead of pretending sample rows are official data.

## Production deployment note

GitHub Pages can host only the frontend. Deploy the Express and FastAPI backends separately. Set `VITE_API_BASE_URL` to the Express API base URL ending in `/api`, `VITE_CHAT_API_BASE_URL` to the FastAPI origin, `CORS_ORIGIN` to the frontend origin on Express, and `CHATBOT_CORS_ORIGINS` to the frontend origin on FastAPI. Keep both Vite API URL variables blank for local development so the Vite proxies are used.

## API endpoints

- `GET /api/health` — backend and dataset status.
- `GET /api/rankings` — prepared records; optional `year` (integer; invalid values return HTTP 400), `category`, `state`, and `search` query parameters. Each record carries an `institution_key` that stays stable across years even when the published name or ID format changed. The unfiltered response is cached and gzip-compressed.
- `GET /api/rankings/meta` — dataset metadata and audit report.
- `POST /api/copilot` — rule-based explanations using current dashboard context. This is not an LLM-backed assistant.
- `POST /api/chat` — FastAPI chatbot endpoint; accepts `{"question":"..."}` and returns an `answer`.

## Using the dashboard

- **Filters** (year, category, state) drive every card. The institution picker only lists institutions in the current filtered view.
- **Full table** expands the ranking table (with search); **View all states** expands the state chart.
- **Export report** downloads the current filtered view as CSV.
- The **API online/offline** pill shows backend health; the data banner has a **Retry** button if loading fails.

## Tests

- Data parser: `python -m unittest discover -s scripts -p "test_*.py" -v`
- After changing the parser, regenerate the dataset from the saved HTML with `python scripts/collect_nirf.py --years 2017-2025 --prepare-only`.

## Source and limitations

Primary source: [National Institutional Ranking Framework (NIRF)](https://www.nirfindia.org/Home/Lists), Ministry of Education, Government of India. This application only treats records successfully parsed from retained official pages as source records. It is not a claim that every ranking category, institution, or metric is available for every year. Review the generated audit before publishing conclusions.
