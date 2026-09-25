# Client onboarding checklist — menu, store details, staff access

**BLOCKED on client data.** No "Product Master Specification v1.1" and no
client data pack (menu, store details, staff list) exists on any machine,
package or transcript — raised to the owner as blocker #1 in the sprint
scope. Everything currently in the system is **demo seed data and is
labelled DEMO** (the receipt itself prints "DEMO — sample data, not a real
sale"). Per the sprint rule, nothing below may be filled from guesswork:
**supplied client data only.**

Each row says who enters it and where. "Owner" here means the client's
owner account (CUSTOMER_OWNER), not VEXO.

## 1 · Company and store details

| Item | Where | Entered by | Status |
|------|-------|-----------|--------|
| Legal / trading name | VEXO admin → company record | VEXO | BLOCKED — awaiting client data |
| Branch name(s), code(s), address, city | `/branches` | Owner | BLOCKED — awaiting client data |
| Branch count vs licence (plan + branch limit) | `/licence` | VEXO | BLOCKED — licence terms not supplied |
| Tables per branch (dine-in) | `/tables` | Owner or manager | BLOCKED — floor plan not supplied |

## 2 · Menu (catalog)

| Item | Where | Entered by | Status |
|------|-------|-----------|--------|
| Tax rates (names + percent, e.g. GST slabs) | `/catalog` → tax rates | Owner | BLOCKED — client GST treatment not supplied |
| Categories and sort order | `/catalog` | Owner | BLOCKED |
| Products: name, base price, tax rate, category | `/catalog` | Owner | BLOCKED |
| Variants (sizes) where applicable | `/catalog` | Owner | BLOCKED |
| Remove/retire the DEMO catalog once the real one is in | `/catalog` | Owner | BLOCKED — depends on the rows above |

Prices entered are **snapshotted onto order lines at ring time** — a later
catalog edit never rewrites an existing bill. Get prices right before the
first live sale, not after.

## 3 · Staff access

| Item | Where | Entered by | Status |
|------|-------|-----------|--------|
| Owner account (email, name) | VEXO console → Invite owner | VEXO invites the first owner | BLOCKED — no staff list |
| Branch managers (per branch) | `/team` | Owner | BLOCKED |
| Cashiers (per branch) | `/team` | Owner | BLOCKED |
| Discount policy: who may discount, up to how much | `/discounts` | Owner | BLOCKED — client's rule not supplied. Until set, the shipped default is deny: a cashier cannot discount at all. |
| Each person sets their own first password from the email they were sent | their mailbox | Each person | BLOCKED — depends on accounts above |

Staff addresses must be **real and reachable**: nobody is given a password to
pass along, so an account whose mail bounces cannot be opened at all. The owner
is invited by link; everyone added on `/team` afterwards gets an 8-digit code
and shows as **Awaiting password** until they redeem it. Full flow, and the
mail configuration it depends on, in `docs/ACCOUNTS-GO-LIVE.md`.

## 4 · Counter hardware (per counter)

| Item | Status |
|------|--------|
| Thermal printer per `frontend/docs/HARDWARE-CHECKLIST.md` | PENDING — physical UAT run-book is `docs/PRINTER-UAT-RUNBOOK.md`, results pending until paper is observed |
| Customer display device paired (`docs/VC101-CUSTOMER-DISPLAY.md`) | Ready in the sprint build; conditional at the freeze |

## When the client data pack arrives

Work top to bottom: company → branches → tax rates → categories →
products → tables → staff → discount policy. Then one test sale per
branch (rung, billed, paid, receipt printed) **before** the DEMO catalog
is retired, and the demo financial records stay untouched throughout —
they are reference data, not garbage.
