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

\echo '=== 0. CONTROL: correct_ist must be stored + 5:30 ==============='
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
WHERE a.action IN ('ORDER_DISCOUNT_SET', 'ORDER_DISCOUNT_CLEAR')
   OR (a.action = 'ORDER_ITEM_UPDATE' AND a.meta ? 'lineDiscount')
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
ORDER BY a.at DESC
LIMIT 100;

\echo ''
\echo '=== 4. Failed logins per account, last 7 days ==================='
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
-- those queries are under-reporting and need widening.
SELECT action, count(*) AS rows,
       max(at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS last_ist
FROM "PosAuditLog"
GROUP BY action
ORDER BY rows DESC;
