import json
import sqlite3
import unittest

import pos_service as ps


class VoucherIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        with open("schema.sql", "r", encoding="utf-8") as f:
            self.conn.executescript(f.read())
        self.conn.commit()
        self.conn.isolation_level = None

    def tearDown(self):
        self.conn.close()

    def _seed_voucher(self, code="GV-100", value=50.0):
        ps.upsert_voucher_head(
            self.conn,
            code,
            "2025-01-01",
            value,
            1,
            {"source": "test"},
        )
        ps.voucher_ledger_add(
            self.conn, code, value, "issue", sale_id=None, note="seed value"
        )

    def _basic_sale(self, extra=None):
        base = {
            "sale_id": (extra or {}).get("sale_id") or "SALE-1",
            "cashier": "demo",
            "customer_id": "Walk-in Customer",
            "warehouse": "Shop",
            "lines": [
                {
                    "item_id": "SKU-001",
                    "item_name": "Test Item",
                    "brand": None,
                    "attributes": {},
                    "qty": 1,
                    "rate": 40.0,
                }
            ],
            "payments": [{"method": "Card", "amount": 30.0}],
        }
        if extra:
            base.update(extra)
        return base

    def test_sale_payload_includes_voucher_codes(self):
        self._seed_voucher("GV-ABC", 80.0)
        sale = self._basic_sale(
            {
                "sale_id": "SALE-V1",
                "payments": [{"method": "Card", "amount": 30.0}],
                "voucher_redeem": [{"code": "GV-ABC", "amount": 10.0}],
            }
        )
        sale_id = ps.record_sale(self.conn, sale)
        row = self.conn.execute(
            "SELECT payload_json FROM outbox WHERE kind='sale' AND ref_id=?",
            (sale_id,),
        ).fetchone()
        self.assertIsNotNone(row, "sale outbox entry missing")
        payload = json.loads(row["payload_json"])
        self.assertEqual(payload.get("pos_voucher_code"), "GV-ABC")
        self.assertEqual(len(payload.get("voucher_redeem") or []), 1)
        self.assertEqual(payload["voucher_redeem"][0]["code"], "GV-ABC")

    def test_push_outbox_triggers_erp_voucher_update(self):
        self._seed_voucher("GV-Z99", 60.0)
        sale = self._basic_sale(
            {
                "sale_id": "SALE-V2",
                "payments": [{"method": "Card", "amount": 30.0}],
                "voucher_redeem": [{"code": "GV-Z99", "amount": 15.0}],
            }
        )
        ps.record_sale(self.conn, sale)
        captured = {}
        original_post = ps.post_sale_to_erpnext
        original_apply = ps._apply_voucher_redemptions_to_erp
        original_base = ps.ERP_BASE

        def fake_post(payload):
            captured["payload"] = payload
            return {"name": "INV-V2"}

        def fake_apply(vouchers, docname, sale_payload):
            captured["apply"] = {
                "vouchers": vouchers,
                "docname": docname,
                "sale_payload": sale_payload,
            }

        try:
            ps.post_sale_to_erpnext = fake_post
            ps._apply_voucher_redemptions_to_erp = fake_apply
            ps.ERP_BASE = "https://example.local"
            ps.push_outbox(self.conn, limit=5)
        finally:
            ps.post_sale_to_erpnext = original_post
            ps._apply_voucher_redemptions_to_erp = original_apply
            ps.ERP_BASE = original_base

        self.assertIn("payload", captured, "ERP payload not sent")
        self.assertIn("apply", captured, "Voucher redemption hook not called")
        self.assertEqual(captured["apply"]["docname"], "INV-V2")
        self.assertEqual(
            captured["apply"]["vouchers"],
            [{"code": "GV-Z99", "amount": 15.0}],
        )


if __name__ == "__main__":
    unittest.main()
