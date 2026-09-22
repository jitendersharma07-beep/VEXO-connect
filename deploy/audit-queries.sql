-- Operator queries against the POS audit log.
--
-- Why this file exists: every discount, refund, void, closing and login is
-- written to "PosAuditLog" with the acting user, their email, their IP and the
-- values involved — and **no screen in the product reads that table**. The
-- record is real but unreachable, which is worse than useless, because
-- "discounts are audited" then sounds like a control that anyone can check.
-- Until a screen exists, this file is how you check it.
--
--   docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos \
--     < deploy/audit-queries.sql
--
-- Read-only. Nothing here writes, and it is safe to run against production
-- during service.
--
-- TWO TRAPS, both of which produce plausible wrong answers rather than errors:
--
-- 1. TIME ZONE. `at` is `timestamp WITHOUT time zone` holding UTC. Converting
--    it with a single `AT TIME ZONE 'Asia/Kolkata'` *interprets* the stored
--    value as IST-local and hands back something 5h30m in the wrong direction
--    — a 21:00 closing reads as 10:00, still inside business hours, still
--    believable. Two conversions are required: label it UTC first, then move
--    it. Query 0 below is a control that shows both side by side; if its
--    `correct_ist` column is not `stored` + 5:30, stop and fix the queries
--    rather than trusting anything under it.
--
-- 2. BEST-EFFORT WRITES. `audit()` in backend/src/lib/audit.js wraps its
--    insert in try/catch so an audit failure can never fail a customer's bill.
--    That is the right trade, but it means absence of a row is NOT proof the
--    action did not happen — a failed write leaves only a `pos audit write
--    failed` warning in the backend log. Treat these results as a lower bound.
--
-- 3. TENANT SCOPE. This database is multi-tenant and these queries span every
--    company by default. That is right for an ATC-side review and WRONG the
--    moment you are answering one customer's question — guide-owner.md §5 tells
--    owners to ask for exactly this, so the day a second café exists, an
--    unscoped run hands one customer another's cashier names. Pass the company:
--
--      docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos \
--        -v company=<companyId> < deploy/audit-queries.sql
--
--    Query 0 prints the id and name of every company so you can find it, and
--    each scoped query echoes the filter it applied. Query 4 is deliberately
--    NOT scoped: failed sign-ins have no authenticated user, so their rows
--    carry a null companyId and a filter would hide every one of them.

\if :{?company}
\else
  \set company ''
\endif

\echo '=== 0. CONTROL: correct_ist must be stored + 5:30 ==============='
\echo '--- companies in this database (use the id with -v company=...) ---'
SELECT id, name, status FROM "Company" ORDER BY "createdAt";
\echo '--- scope applied to queries 1-3 and 5 (blank = ALL COMPANIES) ---'
SELECT CASE WHEN :'company' = '' THEN '*** ALL COMPANIES ***' ELSE :'company' END AS scope;
SELECT
  at                                               AS stored_utc,
  at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata' AS correct_ist,
  at AT TIME ZONE 'Asia/Kolkata'                    AS naive_wrong
FROM "PosAuditLog"
ORDER BY at DESC
LIMIT 3;

\echo ''
\echo '=== 1. Every discount, newest first ============================='
-- Order-level discounts carry {type, value} in meta; line-level ones ride on
-- ORDER_ITEM_UPDATE, which is also emitted for plain quantity edits, so it is
-- filtered on the presence of the lineDiscount key rather than on the action.
SELECT
  (a.at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS ist,
  a."actorEmail",
  a.action,
  a."entityId" AS order_id,
  a.meta
FROM "PosAuditLog" a
-- The outer brackets round the OR are load-bearing. Without them the scope
-- filter binds to the last branch only, and the query silently returns every
-- company's order-level discounts — a wrong answer, not an error.
WHERE (a.action IN ('ORDER_DISCOUNT_SET', 'ORDER_DISCOUNT_CLEAR')
       OR (a.action = 'ORDER_ITEM_UPDATE' AND a.meta ? 'lineDiscount'))
  AND (:'company' = '' OR a."companyId" = :'company')
ORDER BY a.at DESC
LIMIT 100;

\echo ''
\echo '=== 2. Discounts per person, last 30 days ======================='
-- The shrinkage question. A cashier who discounts far more often than the
-- others is the signal; the rupee total alone is not, because one large
-- legitimate discount outweighs many small suspicious ones.
SELECT
  a."actorEmail",
  count(*) FILTER (WHERE a.action = 'ORDER_DISCOUNT_SET')   AS order_discounts,
  count(*) FILTER (WHERE a.action = 'ORDER_ITEM_UPDATE')    AS line_discounts,
  count(*) FILTER (WHERE a.action = 'ORDER_DISCOUNT_CLEAR') AS cleared,
  max(a.at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')  AS last_ist
FROM "PosAuditLog" a
WHERE a.at > now() - interval '30 days'
  AND (a.action IN ('ORDER_DISCOUNT_SET', 'ORDER_DISCOUNT_CLEAR')
       OR (a.action = 'ORDER_ITEM_UPDATE' AND a.meta ? 'lineDiscount'))
  AND (:'company' = '' OR a."companyId" = :'company')
GROUP BY a."actorEmail"
-- Repeating the aggregates rather than adding the output aliases: Postgres
-- allows a bare alias in ORDER BY but not an expression over aliases, and the
-- alias form fails at run time, not at review time.
ORDER BY count(*) FILTER (WHERE a.action = 'ORDER_DISCOUNT_SET')
       + count(*) FILTER (WHERE a.action = 'ORDER_ITEM_UPDATE') DESC;

\echo ''
\echo '=== 3. Refunds and voids, last 30 days =========================='
SELECT
  (a.at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS ist,
  a."actorEmail",
  a.action,
  a."entityId" AS order_id,
  a.meta
FROM "PosAuditLog" a
WHERE a.action IN ('ORDER_REFUND', 'ORDER_VOID', 'ORDER_ITEM_VOID', 'ORDER_CANCEL')
  AND a.at > now() - interval '30 days'
  AND (:'company' = '' OR a."companyId" = :'company')
ORDER BY a.at DESC
LIMIT 100;

\echo ''
\echo '=== 4. Failed logins per account, last 7 days (ALL COMPANIES) ==='
-- NOT scoped by company, on purpose, and the reason is the opposite of
-- harmless. A failure against a *known* address resolves a user and so carries
-- that user's companyId; a failure against an address that does not exist here
-- resolves nobody and carries null. Scoping therefore keeps the former and
-- silently drops the latter — which is backwards, because the unknown-address
-- pile is the attack signal. Measured on production 2026-09-22: 36 failures
-- unscoped, 4 under `-v company=...`, and the 30 attempts at one address that
-- does not exist were among the 32 that disappeared.
--
-- Treat this section as ATC-side only; it spans tenants, so do not paste its
-- output to a customer.
--
-- Read the email out of `meta`, NOT out of `actorEmail`. On a failed login
-- there is no authenticated user, so `actorEmail` is null on every one of
-- these rows and grouping by it silently collapses every account in the
-- building into a single line — which reads like one noisy user rather than
-- an attack spread across many names. auth.js records the attempted address
-- in meta.email and why it was refused in meta.reason.
--
-- `reason` is the column that matters: a pile of `bad-password` on one real
-- address is a forgotten password or a targeted guess, while a pile of
-- `unknown-email` is someone trying names that do not exist here.
SELECT
  a.meta ->> 'email'  AS attempted_email,
  a.meta ->> 'reason' AS reason,
  count(*) AS failures,
  max(a.at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS last_ist
FROM "PosAuditLog" a
WHERE a.action = 'LOGIN_FAILED'
  AND a.at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY failures DESC
LIMIT 50;

\echo ''
\echo '=== 5. What actions exist at all ================================'
-- Run this before trusting the filters above. If an action name in this list
-- looks like a discount, a void or a refund and is missing from queries 1-3,
-- those queries are under-reporting and need widening. It is also where ATC's
-- own actions appear (COMPANY_*, LICENSE_*, USER_CREATE).
--
-- Run it unscoped at least once when auditing the queries themselves. Rows with
-- a null companyId drop out under `-v company=...`, so a scoped run can hide
-- the very action name you are checking for. That is not a rare edge: on
-- production 2026-09-22 the scope took LOGIN_FAILED from 36 rows to 4 and
-- LOGIN_SUCCESS from 23 to 18 — the missing sign-ins are ATC's own, since a
-- VEXO administrator belongs to no company. Correct for a customer report,
-- misleading if you are trying to establish what the system records.
SELECT action, count(*) AS rows,
       max(at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS last_ist
FROM "PosAuditLog" a
WHERE (:'company' = '' OR a."companyId" = :'company')
GROUP BY action
ORDER BY rows DESC;
