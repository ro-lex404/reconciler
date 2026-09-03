import os
import shutil
import tempfile
import unittest
from pathlib import Path
import duckdb

from fastapi.testclient import TestClient
from app.main import app
from app.services.reconciliation import (
    default_finance_data_dir,
    list_available_datasets,
    delete_finance_dataset,
    set_active_period,
    get_active_period,
    reconcile_settlements,
    resolve_finance_dataset_paths,
    get_reconciliation_context_summary,
    update_latest_pdf_reconciliation,
    LATEST_PDF_RECONCILIATION,
)

SAMPLE_BANK_CSV = """bank_ref,value_date,credit_amount,description,utr_number
BK1001,2026-08-01,1500.00,NEFT/RZRPY/REF1001/SETTLEMENT,UTR001
BK1002,2026-08-02,2450.00,NEFT/RZRPY/REF1002/SETTLEMENT,UTR002
BK1003,2026-08-03,3200.00,NEFT/RZRPY/REF1003/SETTLEMENT,UTR003
BK1004,2026-08-04,500.00,MISC DIRECT CREDIT,UTR004
"""

SAMPLE_RAZORPAY_CSV = """payment_id,amount,date,status,merchant_ref,merchant_category
pay_001,1500.00,2026-08-01,captured,REF1001,ecommerce
pay_002,2450.00,2026-08-02,captured,REF1002,saas
pay_003,3200.00,2026-08-03,captured,REF1003,services
pay_005,999.00,2026-08-05,captured,REF1005,ecommerce
"""

SAMPLE_PDF_BYTES = b"%PDF-1.4 Mock invoice content for test %EOF"


class StressTestDatasetDeletion(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="stress_reconciler_")
        self.orig_data_dir = os.environ.get("FINANCE_DATA_DIR")
        os.environ["FINANCE_DATA_DIR"] = self.test_dir
        self.client = TestClient(app, raise_server_exceptions=False)

        # Setup multi-period hierarchy: 2026/august, 2026/july, 2025/december, 2024/january
        self._populate_dataset("2026", "august")
        self._populate_dataset("2026", "july")
        self._populate_dataset("2025", "december")
        self._populate_dataset("2024", "january")
        set_active_period("2026", "august")

    def tearDown(self):
        if self.orig_data_dir is not None:
            os.environ["FINANCE_DATA_DIR"] = self.orig_data_dir
        else:
            os.environ.pop("FINANCE_DATA_DIR", None)
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir, ignore_errors=True)

    def _populate_dataset(self, year: str, month: str):
        target = Path(self.test_dir) / year / month
        target.mkdir(parents=True, exist_ok=True)
        with open(target / "bank_statement.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_BANK_CSV)
        with open(target / f"bank_statement_{month}.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_BANK_CSV)
        with open(target / "razorpay_settlements.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_RAZORPAY_CSV)
        with open(target / f"razorpay_settlements_{month}.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_RAZORPAY_CSV)
        with open(target / "invoices.pdf", "wb") as f:
            f.write(SAMPLE_PDF_BYTES)
        with open(target / f"invoices_{month}.pdf", "wb") as f:
            f.write(SAMPLE_PDF_BYTES)

    # 1. Stress test Windows file locking: DuckDB queries then file deletion
    def test_windows_duckdb_file_lock_and_immediate_deletion(self):
        aug_dir = Path(self.test_dir) / "2026" / "august"
        rp_path = aug_dir / "razorpay_settlements.csv"
        bk_path = aug_dir / "bank_statement.csv"

        # Query DuckDB 10 times in tight loop to hold/open connections
        for _ in range(10):
            res = reconcile_settlements(rp_path, bk_path)
            self.assertEqual(res["total_transactions"], 4)

        # Immediately delete the dataset files via API
        del_res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "all"},
        )
        self.assertEqual(del_res.status_code, 200)
        self.assertFalse(aug_dir.exists(), "Directory should be completely unlinked despite DuckDB query history")

    # 2. Cascade deletion of all periods and fallback state
    def test_cascade_delete_all_periods_fallback_chain(self):
        self.assertEqual(get_active_period(), ("2026", "august"))

        # Delete active (2026/august) -> should switch to a remaining dataset
        res1 = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "all"},
        )
        self.assertEqual(res1.status_code, 200)
        data1 = res1.json()
        self.assertNotEqual(data1["active_period"], {"year": "2026", "month": "august"})
        remaining_months = [d["month"] for d in data1["datasets"]]
        self.assertIn(data1["active_period"]["month"], remaining_months)

        # Delete all remaining periods
        while True:
            cur_datasets = list_available_datasets()["datasets"]
            if not cur_datasets:
                break
            target_ds = cur_datasets[0]
            del_r = self.client.request(
                "DELETE",
                "/finance/dataset",
                json={"passcode": "admin", "year": target_ds["year"], "month": target_ds["month"], "file_type": "all"},
            )
            self.assertEqual(del_r.status_code, 200)

        empty_datasets = list_available_datasets()
        self.assertEqual(len(empty_datasets["datasets"]), 0)
        self.assertEqual(get_active_period(), ("2026", "july"))

    # 3. EMPIRICAL BUG REPRODUCTION: Partial bank deletion leaves active period with missing bank, causing DuckDB crash (500)
    def test_reproduce_partial_bank_deletion_causes_500_on_reconcile(self):
        set_active_period("2026", "august")
        
        # Delete bank statement only
        del_res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "bank"},
        )
        self.assertEqual(del_res.status_code, 200)
        
        # Verify active period was NOT switched because razorpay still exists
        self.assertEqual(get_active_period(), ("2026", "august"))

        # Now call /finance/reconcile: crashes with 500 because DuckDB read_csv_auto cannot find bank_statement.csv
        rec_res = self.client.post("/finance/reconcile", json={})
        self.assertEqual(rec_res.status_code, 500, "Observed DuckDB IOException resulting in HTTP 500")

    # 4. EMPIRICAL BUG REPRODUCTION: Windows backslash in compound month path fails with 400
    def test_reproduce_windows_backslash_compound_month_path_fails_400(self):
        self._populate_dataset("2026", "slash_test")
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "month": "2026\\slash_test", "file_type": "all"},
        )
        # In main.py line 283: `if "/" in str(effective_month):` does not match backslash
        self.assertEqual(res.status_code, 400, "Fails with 400 because backslash is not handled prior to checking '/'")

    # 5. Deleting inactive period does NOT switch active period
    def test_delete_inactive_period_preserves_active(self):
        set_active_period("2026", "august")
        
        # Delete 2025/december
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2025", "month": "december", "file_type": "all"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["active_period"], {"year": "2026", "month": "august"})
        self.assertEqual(get_active_period(), ("2026", "august"))

    # 6. DuckDB queries on active period switch to new period seamlessly
    def test_duckdb_reconciliation_seamless_on_period_switch(self):
        set_active_period("2026", "august")
        rp, bk = resolve_finance_dataset_paths()
        res_aug = reconcile_settlements(rp, bk)
        self.assertEqual(res_aug["total_transactions"], 4)

        # Purge august
        self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "all"},
        )

        # Resolve paths again -> should automatically resolve to newly active period
        rp_new, bk_new = resolve_finance_dataset_paths()
        self.assertTrue(rp_new.exists())
        self.assertTrue(bk_new.exists())
        
        # Run DuckDB reconciliation on new active dataset
        res_new = reconcile_settlements(rp_new, bk_new)
        self.assertEqual(res_new["total_transactions"], 4)

    # 7. Context summary & AI chatbot state after full period deletion
    def test_reconciliation_context_summary_stability_after_deletion(self):
        set_active_period("2026", "august")
        summary_before = get_reconciliation_context_summary()
        self.assertIn("Live Reconciliation Metrics", summary_before)
        self.assertIn("Total Transactions Processed: 4", summary_before)

        # Delete august
        self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "all"},
        )

        # Get context summary after deletion -> must succeed without throwing
        summary_after = get_reconciliation_context_summary()
        self.assertIn("Live Reconciliation Metrics", summary_after)
        self.assertIn("Total Transactions Processed: 4", summary_after)

    # 8. Passcode security permutations
    def test_passcode_permutations_and_security(self):
        # Empty string passcode
        res1 = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "", "year": "2026", "month": "july"},
        )
        self.assertEqual(res1.status_code, 401)

        # Whitespace-only passcode
        res2 = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "   ", "year": "2026", "month": "july"},
        )
        self.assertEqual(res2.status_code, 401)

        # Passcode with leading/trailing spaces but valid word
        res3 = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": " admin ", "year": "2024", "month": "january", "file_type": "bank"},
        )
        self.assertEqual(res3.status_code, 200)

    # 9. Invariant response contract validation
    def test_delete_endpoint_response_schema_contract(self):
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2024", "month": "january", "file_type": "all"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        
        # Check top-level contract keys
        self.assertIn("status", data)
        self.assertEqual(data["status"], "success")
        self.assertIn("deleted", data)
        self.assertIn("active_period", data)
        self.assertIn("datasets", data)

        # Check deleted sub-object keys
        deleted = data["deleted"]
        self.assertIn("year", deleted)
        self.assertIn("month", deleted)
        self.assertIn("scope", deleted)
        self.assertIn("deleted_paths", deleted)
        self.assertIsInstance(deleted["deleted_paths"], list)

        # Check active_period sub-object keys
        active = data["active_period"]
        self.assertIn("year", active)
        self.assertIn("month", active)


if __name__ == "__main__":
    unittest.main()
