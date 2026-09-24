-- Foundation lane — rehearsal FINGERPRINT of the pre-existing Core data.
--
-- Selects ONLY columns that exist at the base schema (38856d3), so the output
-- must be byte-identical before and after the foundation migrations. Any
-- difference means a migration rewrote, dropped or added an existing row.
-- Run with: psql -qAt -f foundation-rehearsal-fingerprint.sql

SELECT 'Company', count(*), md5(coalesce(string_agg(concat_ws('|', id, name, slug, status, "isDemo", state, "createdAt"), ',' ORDER BY id), '')) FROM "Company";
SELECT 'Branch', count(*), md5(coalesce(string_agg(concat_ws('|', id, "companyId", name, code, status, "isDemo", "addressLine", city, state, "createdAt"), ',' ORDER BY id), '')) FROM "Branch";
SELECT 'PosUser', count(*), md5(coalesce(string_agg(concat_ws('|', id, "companyId", "branchId", email, role, status), ',' ORDER BY id), '')) FROM "PosUser";
SELECT 'License', count(*), md5(coalesce(string_agg(concat_ws('|', id, "companyId", plan, status, "baseBranchLimit", "expiresAt"), ',' ORDER BY id), '')) FROM "License";
SELECT 'Order', count(*), md5(coalesce(string_agg(concat_ws('|', id, "companyId", "branchId", type, status, "invoiceNumber", subtotal, "discountAmount", "taxAmount", total, "billedAt", "closedAt", "updatedAt"), ',' ORDER BY id), '')) FROM "Order";
SELECT 'OrderItem', count(*), md5(coalesce(string_agg(concat_ws('|', id, "orderId", name, "unitPrice", qty, "lineSubtotal", "lineTax", "lineTotal", status), ',' ORDER BY id), '')) FROM "OrderItem";
SELECT 'Payment', count(*), md5(coalesce(string_agg(concat_ws('|', id, "orderId", method, channel, amount, tendered, "receivedById", "idempotencyKey", "createdAt"), ',' ORDER BY id), '')) FROM "Payment";
SELECT 'Refund', count(*), md5(coalesce(string_agg(concat_ws('|', id, "orderId", amount, reason, channel, status, method, "byId", "createdAt"), ',' ORDER BY id), '')) FROM "Refund";
SELECT 'InvoiceCounter', count(*), md5(coalesce(string_agg(concat_ws('|', id, "branchId", "fyLabel", "lastNumber"), ',' ORDER BY id), '')) FROM "InvoiceCounter";
SELECT 'DayClose', count(*), md5(coalesce(string_agg(concat_ws('|', id, "branchId", "businessDate", "countedCashPaise", "expectedCashPaise", "variancePaise", "ordersBilled", "supersededById"), ',' ORDER BY id), '')) FROM "DayClose";
SELECT 'PosAuditLog', count(*), md5(coalesce(string_agg(concat_ws('|', id, action, "actorId", "actorRole", "companyId", "entityId"), ',' ORDER BY id), '')) FROM "PosAuditLog";
SELECT 'Money', sum(total)::text, sum("taxAmount")::text, (SELECT sum(amount)::text FROM "Payment"), (SELECT sum(amount)::text FROM "Refund") FROM "Order";
