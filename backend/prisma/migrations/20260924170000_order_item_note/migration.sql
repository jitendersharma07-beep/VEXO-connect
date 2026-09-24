-- OrderItem.note ("no onion") is in schema.prisma and the generated client but
-- 20260924120000_kitchen_print_agent never added the column, so every Prisma
-- write/read of OrderItem failed with "column note does not exist" — the root
-- error of the 2026-09-24 08:18 run (209 failures). Additive, forward-only.
ALTER TABLE "OrderItem" ADD COLUMN "note" TEXT;
