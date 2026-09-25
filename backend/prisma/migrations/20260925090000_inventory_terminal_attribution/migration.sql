-- Terminal attribution on the stock ledger (INV-B2).
--
-- StockMovement."terminalId" has existed since 20260924400000_inventory_core,
-- deliberately unconstrained: the column was created ahead of the Terminal
-- model so that wiring it up later would be a constraint on an existing column
-- rather than a migration rewriting a live ledger. This is that constraint.
--
-- The foreign key is the PAIR ("terminalId", "companyId"), not "terminalId"
-- alone. StockMovement carries a denormalised companyId that nothing checked;
-- pairing it here makes the database refuse a till belonging to another tenant.
-- Terminal has no unique index on (id, companyId) yet — only (id, branchId),
-- which the ledger cannot use, because a movement's store is its location's and
-- a location need not have one: a warehouse or a central kitchen belongs to the
-- company and to no store at all.
--
-- MATCH SIMPLE (the default) is what makes this safe on a nullable column
-- beside a non-nullable one: with "terminalId" NULL the pair is not checked, so
-- every posting no till caused — goods receipts, counts, wastage, transfers,
-- production, the scheduler — still writes exactly as before.
--
-- Safe to apply to a populated ledger: every existing StockMovement."terminalId"
-- is NULL, so the validating scan passes without rewriting a row. Both
-- statements take a brief ACCESS EXCLUSIVE lock on their table.

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_id_companyId_key" ON "Terminal"("id", "companyId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_terminalId_companyId_fkey" FOREIGN KEY ("terminalId", "companyId") REFERENCES "Terminal"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
