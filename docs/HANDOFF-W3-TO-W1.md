# Window 3 → Window 1 handoff (2026-09-24)

## 1. Documentation delta — review and integrate into the current candidate

Branch **`w3/print-acceptance`**, commit **`b7b5ae5`**, based on RC
`7d11df1` (`sprint/client-handover-rc` from the 2026-09-23 bundle). The
base is older than your current candidate — **cherry-pick / review the
docs delta only**; the commit touches no code:

| File | Change |
|---|---|
| `docs/PRINTER-UAT-RUNBOOK.md` | Replaced with the consolidated canonical procedure + 14-row results record; supersedes the previous copy and declares the register of every other printer doc |
| `frontend/docs/HARDWARE-CHECKLIST.md` | Corrected 2026-09-24 revision (hw-prep `15c27b9`): removes the "576 dots @ 203 dpi ← what this build targets" claim that fails a healthy 180 dpi TM-T88; adds A/B/C capability groups + the 203/180 dpi table |
| `frontend/docs/PRINTER-TEST-SESSION.md` | New in this tree: the 30-minute operator script the runbook register references |
| `docs/BACKUP-EVIDENCE-RECONCILIATION.md` | Backup evidence reconciliation (09-23 16:20Z run confirmed; remaining owner-gated gaps) |

Known deliberate non-fix carried in the checklist: the same dpi conflation
sits in a comment in `frontend/src/index.css` — recorded, not edited (freeze).

## 2. Product finding — reprints are not audited (confirmed on candidate 7d11df1)

**Both reprint reads write no `PosAuditLog` row:**

- `backend/src/api/routes/orders.js:1888` — `GET /orders/:id/receipt`
  (Orders → paid order → receipt, i.e. the receipt REPRINT path)
- `backend/src/api/routes/orders.js:636` — `GET /orders/:id/kots`
  (KOT reprint listing)

The file makes 19 `audit()` calls (bill, pay, refund, void, discount…);
neither reprint handler is among them. So a receipt can be reprinted any
number of times with zero server-side trace, and on paper a reprint is
indistinguishable from the first print (same invoice number, same totals,
no reprint marker).

**Exact reproduction (dev stack, pg 5440):**

1. Sign in at `http://127.0.0.1:5351/`, bill + pay any order; note its id.
2. `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5350/api/orders/<id>/receipt` — repeat 3×.
3. `SELECT action, count(*) FROM "PosAuditLog" WHERE "orderId"='<id>' GROUP BY action;`
   → rows for BILL/PAY etc., **nothing** for the three receipt fetches.

**Suggested fix shape (your call — backend is your domain):** an
`audit(req, { action: 'RECEIPT_REPRINT' … })` (and `KOT_REPRINT`) in those
two handlers; if you want the paper itself distinguishable, the receipt
payload would need a reprint flag/count for the print UI to render — that
half is Window 3's and I will wire the UI once you decide the contract.
Not a hardware-acceptance blocker; it is an audit-trail gap.

## 3. Printer acceptance build identity

Physical acceptance will run per `docs/PRINTER-UAT-RUNBOOK.md` on the dev
stack, whose rendering is byte-unchanged from v1.0.1; the acceptance
record will note the exact dev-stack commit at session start. If you cut a
newer candidate before the printer session, say so and I will re-verify
`Receipt.jsx` / `printPageSize.js` / the receipt endpoints are unchanged and
record that candidate instead. **All physical rows remain NOT TESTED until
paper is observed.**

## 4. Backup

Wiring complete and preserved — nightly ARMED 09-23 16:18:39Z, single
timer; nothing reinstalled. Remaining recovery gaps (restore-from-ciphertext
unproven, key custody, destination) are tracked in
`docs/BACKUP-EVIDENCE-RECONCILIATION.md` as owner-gated items; no
document claims a successful restore.
