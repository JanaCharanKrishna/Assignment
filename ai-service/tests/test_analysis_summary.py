import unittest

import numpy as np

from app.analysis_summary import (
    build_summary_bullets,
    build_summary_paragraph,
    compute_curve_statistics,
)


class AnalysisSummaryTests(unittest.TestCase):
    def test_multi_curve_summary_has_expected_shape(self):
        depths = np.linspace(1000.0, 1100.0, 80)
        data = {
            "GR": np.linspace(40.0, 120.0, 80),
            "RHOB": 2.35 + 0.05 * np.sin(np.linspace(0, 8, 80)),
            "NPHI": 0.18 + 0.03 * np.cos(np.linspace(0, 8, 80)),
        }
        curves = ["GR", "RHOB", "NPHI"]
        findings = [
            {
                "curve": "GR",
                "fromDepth": 1042.0,
                "toDepth": 1056.0,
                "score": 6.4,
                "confidence": 0.82,
                "reason": "spike",
            }
        ]
        dq = {
            "qualityBand": "HIGH",
            "nullPercent": 1.2,
            "clippedPercent": 2.5,
            "effectiveRows": 80,
        }

        stats = compute_curve_statistics(depths=depths, data=data, curves=curves)
        bullets = build_summary_bullets(
            from_depth=1000.0,
            to_depth=1100.0,
            row_count=80,
            curves=curves,
            curve_stats=stats,
            findings=findings,
            anomaly_score=0.63,
            detection_conf=0.77,
            severity_conf=0.71,
            severity_band="HIGH",
            data_quality=dq,
            event_density_per_1000ft=10.0,
            max_curve_bullets=4,
        )
        paragraph = build_summary_paragraph(
            from_depth=1000.0,
            to_depth=1100.0,
            row_count=80,
            curves=curves,
            findings=findings,
            anomaly_score=0.63,
            detection_conf=0.77,
            severity_band="HIGH",
            data_quality=dq,
            curve_stats=stats,
        )

        self.assertGreaterEqual(len(bullets), 7)
        self.assertLessEqual(len(bullets), 8)
        self.assertTrue(isinstance(paragraph, str) and paragraph.strip())
        self.assertTrue(isinstance(stats, dict) and stats)
        self.assertIn("GR", stats)
        for fld in [
            "min",
            "max",
            "mean",
            "std",
            "count",
            "p10",
            "p90",
            "trend",
            "outlierCount",
            "outlierPct",
        ]:
            self.assertIn(fld, stats["GR"])

    def test_recognized_aliases_use_conservative_domain_hints(self):
        depths = np.linspace(2000.0, 2100.0, 60)
        data = {
            "GR": np.linspace(55.0, 130.0, 60),
            "RHOB": 2.45 + 0.03 * np.sin(np.linspace(0, 5, 60)),
            "NPHI": 0.28 + 0.02 * np.cos(np.linspace(0, 6, 60)),
            "RT": np.linspace(1.2, 45.0, 60),
        }
        curves = ["GR", "RHOB", "NPHI", "RT"]
        stats = compute_curve_statistics(depths=depths, data=data, curves=curves)
        bullets = build_summary_bullets(
            from_depth=2000.0,
            to_depth=2100.0,
            row_count=60,
            curves=curves,
            curve_stats=stats,
            findings=[],
            anomaly_score=0.39,
            detection_conf=0.66,
            severity_conf=0.54,
            severity_band="MODERATE",
            data_quality={"qualityBand": "MEDIUM", "nullPercent": 0.0, "clippedPercent": 0.0, "effectiveRows": 60},
            event_density_per_1000ft=0.0,
            max_curve_bullets=4,
        )

        text = " ".join(bullets)
        self.assertIn("Gamma-ray response", text)
        self.assertIn("resistivity", text.lower())

    def test_unknown_curve_keeps_neutral_interpretation(self):
        depths = np.linspace(1500.0, 1600.0, 50)
        data = {"XYZ_SENSOR": np.linspace(2.0, 3.0, 50)}
        curves = ["XYZ_SENSOR"]
        stats = compute_curve_statistics(depths=depths, data=data, curves=curves)
        bullets = build_summary_bullets(
            from_depth=1500.0,
            to_depth=1600.0,
            row_count=50,
            curves=curves,
            curve_stats=stats,
            findings=[],
            anomaly_score=0.11,
            detection_conf=0.42,
            severity_conf=0.31,
            severity_band="LOW",
            data_quality={"qualityBand": "MEDIUM", "nullPercent": 0.0, "clippedPercent": 0.0, "effectiveRows": 50},
            event_density_per_1000ft=0.0,
            max_curve_bullets=4,
        )

        text = " ".join(bullets)
        self.assertIn("curve-specific domain interpretation requires metadata", text)

    def test_low_row_sparse_case_still_generates_informative_output(self):
        depths = np.linspace(1200.0, 1211.0, 12)
        noisy = np.array([np.nan, 1.1, np.nan, 0.8, np.nan, 3.6, np.nan, 0.9, np.nan, 1.0, np.nan, 2.9])
        data = {"GR": noisy}
        curves = ["GR"]
        dq = {
            "qualityBand": "LOW",
            "nullPercent": 50.0,
            "clippedPercent": 0.0,
            "effectiveRows": 6,
        }
        stats = compute_curve_statistics(depths=depths, data=data, curves=curves)
        bullets = build_summary_bullets(
            from_depth=1200.0,
            to_depth=1211.0,
            row_count=12,
            curves=curves,
            curve_stats=stats,
            findings=[],
            anomaly_score=0.21,
            detection_conf=0.29,
            severity_conf=0.25,
            severity_band="LOW",
            data_quality=dq,
            event_density_per_1000ft=0.0,
            max_curve_bullets=4,
        )
        paragraph = build_summary_paragraph(
            from_depth=1200.0,
            to_depth=1211.0,
            row_count=12,
            curves=curves,
            findings=[],
            anomaly_score=0.21,
            detection_conf=0.29,
            severity_band="LOW",
            data_quality=dq,
            curve_stats=stats,
        )

        self.assertGreaterEqual(len(bullets), 7)
        self.assertLessEqual(len(bullets), 8)
        self.assertTrue(any("Data quality is LOW" in b for b in bullets))
        self.assertIn("No consolidated localized interval was retained", paragraph)


if __name__ == "__main__":
    unittest.main()
