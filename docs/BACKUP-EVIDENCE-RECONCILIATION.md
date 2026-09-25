# Off-host backup — evidence reconciliation and remaining gaps (2026-09-24)

Window 3 (operational acceptance). Sources: local files only — offhost state log,
systemd unit + drop-in, `~/atc-pos-lanes/offhost/`, OPS-HANDOVER.md. The
destination host (20.20.20.57) was NOT accessed: it is the prohibited VM lab.
No key, backup, credential or destination was touched.

## What is already done — do not redo

| Claim | Evidence |
|---|---|
| Owner's 2026-09-23 16:20 UTC run succeeded | `pos-prod-20260923T162012Z.tar.gpg` shipped 16:20:18.882Z, `status=ok` in `~/atc-backups/offhost-state/offhost.log` |
| Nightly off-host send is ARMED | drop-in `/etc/systemd/system/atc-pos-backup.service.d/10-offhost.conf` installed 2026-09-23 16:18:39Z (Window 2); service now has 2 ExecStarts; single timer 02:30 IST — **no new timer, no re-wiring** |
| Encryption | gpg to fingerprint `2B64FAF2AD2F917F2E2185F60F05CA51AEC13029`; sender B `~/ops/pos-backup/pos-backup-offhost.mjs` |
| Prior verified copy | 2026-09-23 15:04Z at `atc@20.20.20.57:/home/atc/atc-backups/pos-prod-offhost/` |

## Remaining gaps — each needs the OWNER, none needs re-wiring

1. **Restore-from-ciphertext never proven.** Nobody has decrypted a shipped
   `.tar.gpg` and restored it. Scripts exist:
   `~/atc-pos-lanes/offhost/deploy/pos-offhost-*.sh`. Owner-assisted step:
   copy one archive + the restore script to the owner's Mac, decrypt with the
   private key there, restore into a scratch Postgres, verify order counts.
   Until this runs once, the backup is *shipped*, not *restorable*.
2. **Private key custody.** The gpg PRIVATE key (keygrip `7928F17C…`,
   passphrase-protected) still lives on the POS host — the host it is meant to
   protect against. Owner steps: export to the Mac, prove a Mac-side
   decryption (gap 1), and only after BOTH are proven delete the host copy.
   Three-part gate: exported → restore proven off-host → then delete. Never
   delete first.
3. **Destination is on-site.** 20.20.20.57 is the same /24 — a replica, not
   off-site; the receiving `server@atc` key is unrestricted and the drop dir
   is not append-only. Choosing a true off-site destination / restricting the
   key is an owner decision; Window 3 will not select one.
4. **Sender A cutover** prepared, not installed — belongs to the deployment
   owner (OPS-HANDOVER.md §4.6). Not Window 3 scope.
5. **Root disk 86%** (~3–5 days to 95% at current growth); backups compete
   for the same volume. Expansion plan: `docs/DISK-EXPANSION-PLAN.md`,
   pending owner.

## Reprint audit finding (software, recorded here so the runbook stays paper-only)

`GET /orders/:id/receipt` (backend `src/api/routes/orders.js:1867`) returns
the rebuilt receipt and writes **no PosAuditLog row** — reprints are not
audited server-side. On paper, a reprint is identifiable only by carrying the
same invoice number and totals as the first print (runbook step 4 / row 7).
If per-reprint audit is wanted, it is a small backend change — Window 1's
call, not a hardware-acceptance blocker.
