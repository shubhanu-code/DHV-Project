# NIRF data folders

- `raw/<year>/`: verbatim official NIRF HTML pages fetched by the collector. These are intentionally excluded from Git by default; retain them locally for provenance and reproducibility.
- `processed/rankings.csv` and `rankings.json`: generated cleaned records consumed by the Express API.
- `processed/category_registry.json`: year-specific category availability and source-page registry.
- `processed/audit_report.json`: collection errors, missing-value counts, duplicate removals and record counts.

No sample ranking rows are checked in. Run the collection pipeline to create the processed files from official sources. An empty dataset is treated as unavailable, not as zero rankings.
