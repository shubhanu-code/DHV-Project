import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("collect_nirf", Path(__file__).with_name("collect_nirf.py"))
collect_nirf = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collect_nirf)


class ParseRankingTests(unittest.TestCase):
    def setUp(self):
        self.html = """<!doctype html><html><body><table>
        <tr><th>Institute ID</th><th>Name</th><th>City</th><th>State</th><th>Score</th><th>Rank</th></tr>
        <tr><td>IR-O-U-0456</td><td>Indian Institute of Technology Madras <a>More Details Close</a></td><td>Chennai</td><td>Tamil Nadu</td><td>87.31</td><td>1</td></tr>
        <tr style="display:none"><td colspan="6"><table><tr><td>TLR (100)</td><td>90.58</td><td>RPC (100)</td><td>88.02</td><td>GO (100)</td><td>87.01</td><td>OI (100)</td><td>63.34</td><td>PERCEPTION (100)</td><td>100.00</td></tr></table></td></tr>
        <tr><td>IR-O-U-9999</td><td>Example Institution</td><td>Example City</td><td>Pondicherry</td><td>55.20</td><td>101–150</td></tr>
        </table></body></html>"""

    def test_parses_rank_score_names_and_parameter_values(self):
        rows = collect_nirf.parse_ranking_html(self.html, 2025, "Overall", "Overall", "https://www.nirfindia.org/Rankings/2025/OverallRanking.html", "2026-01-01T00:00:00+00:00")
        self.assertEqual(len(rows), 2)
        row = rows[0]
        self.assertEqual(row["institution_id_original"], "IR-O-U-0456")
        self.assertEqual(row["institution_name_standard"], "Indian Institute of Technology Madras")
        self.assertEqual(row["state_standard"], "Tamil Nadu")
        self.assertEqual(row["rank"], 1)
        self.assertEqual(row["score"], 87.31)
        self.assertEqual(row["tlr"], 90.58)
        self.assertEqual(row["rpc"], 88.02)
        self.assertEqual(row["perception"], 100.0)

    def test_preserves_rank_band_label(self):
        rows = collect_nirf.parse_ranking_html(self.html, 2025, "Overall", "Overall", "https://www.nirfindia.org/Rankings/2025/OverallRanking.html", "2026-01-01T00:00:00+00:00")
        band = next(row for row in rows if row["institution_id_original"] == "IR-O-U-9999")
        self.assertEqual(band["rank"], 101)
        self.assertEqual(band["rank_label"], "101–150")

    def test_strips_ui_chrome_from_names(self):
        for raw in ("Miranda House More Details Close |", "Shyam Lal College More Details Close | Close |",
                    "Thapar Institute (Deemed-to-be-university) More Details Close | |", "Plain College"):
            name = collect_nirf.standard_name(raw)
            self.assertNotIn("Close", name)
            self.assertNotIn("|", name)
            self.assertFalse(name.endswith(" "))
        self.assertEqual(collect_nirf.standard_name("Miranda House More Details Close |"), "Miranda House")

    def test_normalizes_uppercase_states(self):
        self.assertEqual(collect_nirf.normalize_state("TAMIL NADU"), "Tamil Nadu")
        self.assertEqual(collect_nirf.normalize_state("JAMMU AND KASHMIR"), "Jammu and Kashmir")
        self.assertEqual(collect_nirf.normalize_state("DELHI"), "Delhi")

    def test_standardizes_category_and_state_aliases(self):
        self.assertEqual(collect_nirf.normalize_category("Universities"), "University")
        self.assertEqual(collect_nirf.normalize_state("Pondicherry"), "Puducherry")


if __name__ == "__main__":
    unittest.main()
