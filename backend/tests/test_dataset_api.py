import os
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from app.main import app
from app.services.reconciliation import (
    default_finance_data_dir,
    list_available_datasets,
    delete_finance_dataset,
    set_active_period,
    get_active_period,
    reconcile_settlements,
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

SAMPLE_PDF_BYTES = b"%PDF-1.4 Mock PDF content for test invoice records %EOF"


class TestDatasetAPI(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="reconciler_test_data_")
        self.orig_data_dir = os.environ.get("FINANCE_DATA_DIR")
        os.environ["FINANCE_DATA_DIR"] = self.test_dir
        self.client = TestClient(app)

        # Setup standard datasets in temp dir: 2026/august and 2026/july
        self._populate_dataset("2026", "august")
        self._populate_dataset("2026", "july")
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
        with open(target / f"bank_statement_{month}_{year}.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_BANK_CSV)
        with open(target / "razorpay_settlements.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_RAZORPAY_CSV)
        with open(target / f"razorpay_settlements_{month}.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_RAZORPAY_CSV)
        with open(target / f"razorpay_settlements_{month}_{year}.csv", "w", encoding="utf-8") as f:
            f.write(SAMPLE_RAZORPAY_CSV)
        with open(target / "invoices.pdf", "wb") as f:
            f.write(SAMPLE_PDF_BYTES)
        with open(target / f"invoices_{month}.pdf", "wb") as f:
            f.write(SAMPLE_PDF_BYTES)
        with open(target / f"invoices_{month}_{year}.pdf", "wb") as f:
            f.write(SAMPLE_PDF_BYTES)

    def test_delete_unauthorized_missing_or_invalid_passcode(self):
        # Missing passcode in JSON body
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"year": "2026", "month": "august", "file_type": "all"},
        )
        self.assertEqual(res.status_code, 401)
        self.assertIn("Unauthorized", res.json().get("error", ""))

        # Invalid passcode
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "wrongpassword", "year": "2026", "month": "august"},
        )
        self.assertEqual(res.status_code, 401)
        self.assertIn("Unauthorized", res.json().get("error", ""))

        # Query param invalid passcode
        res = self.client.delete("/finance/dataset?passcode=badpass&year=2026&month=august")
        self.assertEqual(res.status_code, 401)

    def test_delete_authorized_passcodes_case_insensitivity(self):
        for code in ["admin", "ADMIN", "Admin", "controller", "controller2026"]:
            # Setup a temporary dataset to delete
            month_name = f"test_{code.lower()}"
            self._populate_dataset("2026", month_name)
            res = self.client.request(
                "DELETE",
                "/finance/dataset",
                json={"passcode": code, "year": "2026", "month": month_name, "file_type": "all"},
            )
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json().get("status"), "success")

    def test_delete_missing_year_or_month_returns_400(self):
        # Missing both year and month
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin"},
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("Missing required year or month", res.json().get("error", ""))

        # Missing year
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "month": "august"},
        )
        self.assertEqual(res.status_code, 400)

        # Missing month
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026"},
        )
        self.assertEqual(res.status_code, 400)

    def test_delete_nonexistent_dataset_or_file_returns_404(self):
        # Non-existent period
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2099", "month": "december"},
        )
        self.assertEqual(res.status_code, 404)
        self.assertIn("not found", res.json().get("error", "").lower())

        # Non-existent specific file in existing dataset
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "nonexistent_file.csv"},
        )
        self.assertEqual(res.status_code, 404)

    def test_delete_single_bank_file(self):
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "bank"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["deleted"]["scope"], "bank")

        # Verify bank files are removed from disk
        aug_dir = Path(self.test_dir) / "2026" / "august"
        self.assertFalse((aug_dir / "bank_statement.csv").exists())
        self.assertFalse((aug_dir / "bank_statement_august.csv").exists())

        # Verify razorpay and invoices still exist
        self.assertTrue((aug_dir / "razorpay_settlements.csv").exists())
        self.assertTrue((aug_dir / "invoices.pdf").exists())

        # Verify list_available_datasets reflects state
        datasets = data["datasets"]
        aug_ds = next((d for d in datasets if d["month"] == "august"), None)
        self.assertIsNotNone(aug_ds)
        self.assertFalse(aug_ds["has_bank"])
        self.assertTrue(aug_ds["has_razorpay"])
        self.assertTrue(aug_ds["has_invoices"])

    def test_delete_single_razorpay_file(self):
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "razorpay"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["deleted"]["scope"], "razorpay")

        aug_dir = Path(self.test_dir) / "2026" / "august"
        self.assertFalse((aug_dir / "razorpay_settlements.csv").exists())
        self.assertTrue((aug_dir / "bank_statement.csv").exists())

        datasets = data["datasets"]
        aug_ds = next((d for d in datasets if d["month"] == "august"), None)
        self.assertIsNotNone(aug_ds)
        self.assertFalse(aug_ds["has_razorpay"])
        self.assertTrue(aug_ds["has_bank"])

    def test_delete_single_invoice_file_and_cache_invalidation(self):
        # Set dummy PDF cache
        update_latest_pdf_reconciliation({"filename": "invoices_august.pdf", "records": [1, 2, 3]})

        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "invoice"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["deleted"]["scope"], "invoice")

        aug_dir = Path(self.test_dir) / "2026" / "august"
        self.assertFalse((aug_dir / "invoices.pdf").exists())
        self.assertFalse((aug_dir / "invoices_august.pdf").exists())

        # Verify PDF cache was invalidated
        from app.services import reconciliation
        self.assertIsNone(reconciliation.LATEST_PDF_RECONCILIATION)

    def test_delete_full_monthly_batch_directory(self):
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "all"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")

        # Verify directory is deleted from disk
        aug_dir = Path(self.test_dir) / "2026" / "august"
        self.assertFalse(aug_dir.exists())

        # Verify list_available_datasets no longer includes august
        datasets = data["datasets"]
        self.assertFalse(any(d["month"] == "august" for d in datasets))
        self.assertTrue(any(d["month"] == "july" for d in datasets))

    def test_active_period_fallback_when_active_month_purged(self):
        # Set active period to august
        set_active_period("2026", "august")
        self.assertEqual(get_active_period(), ("2026", "august"))

        # Delete active dataset (august)
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "all"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()

        # Verify active period fell back to july
        self.assertEqual(data["active_period"]["month"], "july")
        self.assertEqual(data["active_period"]["year"], "2026")
        self.assertEqual(get_active_period(), ("2026", "july"))

    def test_delete_via_query_parameters(self):
        res = self.client.delete("/finance/dataset?passcode=admin&year=2026&month=august&file_type=all")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["deleted"]["year"], "2026")
        self.assertEqual(data["deleted"]["month"], "august")

    def test_duckdb_state_synchronization_after_deletion(self):
        aug_dir = Path(self.test_dir) / "2026" / "august"
        rp_path = aug_dir / "razorpay_settlements.csv"
        bk_path = aug_dir / "bank_statement.csv"

        # 1. Run initial reconciliation with DuckDB
        initial_res = reconcile_settlements(rp_path, bk_path)
        self.assertEqual(initial_res["total_transactions"], 4)
        self.assertEqual(initial_res["bank_entries"], 4)
        self.assertEqual(initial_res["matched_transactions"], 3)

        # 2. Delete bank file
        del_res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "bank"},
        )
        self.assertEqual(del_res.status_code, 200)

        # 3. Create a modified bank file with only 1 transaction
        with open(bk_path, "w", encoding="utf-8") as f:
            f.write("bank_ref,value_date,credit_amount,description,utr_number\nBK1001,2026-08-01,1500.00,NEFT/RZRPY/REF1001/SETTLEMENT,UTR001\n")

        # 4. DuckDB query immediately reflects the updated disk file without caching delay
        updated_res = reconcile_settlements(rp_path, bk_path)
        self.assertEqual(updated_res["bank_entries"], 1)
        self.assertEqual(updated_res["matched_transactions"], 1)

    def test_delete_specific_custom_filename(self):
        aug_dir = Path(self.test_dir) / "2026" / "august"
        custom_file = aug_dir / "custom_extra.csv"
        with open(custom_file, "w", encoding="utf-8") as f:
            f.write(SAMPLE_BANK_CSV)
        self.assertTrue(custom_file.exists())

        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "august", "file_type": "custom_extra.csv"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertFalse(custom_file.exists())

    def test_delete_via_header_passcode(self):
        self._populate_dataset("2026", "header_test")
        res = self.client.delete(
            "/finance/dataset?year=2026&month=header_test&file_type=all",
            headers={"x-passcode": "admin"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("status"), "success")

    def test_delete_compound_month_path(self):
        self._populate_dataset("2026", "compound_test")
        res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "month": "2026/compound_test", "file_type": "all"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("status"), "success")

    def test_upload_and_delete_lifecycle(self):
        # 1. Upload new dataset for 2026/september
        csv_content = b"bank_ref,value_date,credit_amount,description,utr_number\nBK1,2026-09-01,100,REF1,U1\n"
        upload_res = self.client.post(
            "/finance/upload-dataset",
            data={"dataset_type": "bank", "month": "2026/september", "passcode": "admin"},
            files={"file": ("bank_statement.csv", csv_content, "text/csv")},
        )
        self.assertEqual(upload_res.status_code, 200)

        # 2. Verify dataset appears in list
        list_res = self.client.get("/finance/datasets")
        self.assertEqual(list_res.status_code, 200)
        datasets = list_res.json().get("datasets", [])
        self.assertTrue(any(d["month"] == "september" for d in datasets))

        # 3. Delete dataset
        del_res = self.client.request(
            "DELETE",
            "/finance/dataset",
            json={"passcode": "admin", "year": "2026", "month": "september", "file_type": "all"},
        )
        self.assertEqual(del_res.status_code, 200)

        # 4. Verify dataset is gone
        list_res_after = self.client.get("/finance/datasets")
        datasets_after = list_res_after.json().get("datasets", [])
        self.assertFalse(any(d["month"] == "september" for d in datasets_after))


if __name__ == "__main__":
    unittest.main()

