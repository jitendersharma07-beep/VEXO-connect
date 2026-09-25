-- LANE payments — enum members only.
--
-- Split from the migration that uses them because Postgres refuses to read a
-- value added by ALTER TYPE ... ADD VALUE inside the same transaction that
-- added it, and the next migration's CHECK constraint names PaymentChannel
-- 'TERMINAL'. One file per transaction is the only way to have both.

-- A card terminal is a Device like any other, so its credential, store scope
-- and revocation work exactly the same way.
ALTER TYPE "DeviceType" ADD VALUE 'PAYMENT_TERMINAL';

-- The attempt reached the provider or the terminal and the outcome could not
-- be established. Never auto-retried, never silently turned into a manual
-- payment — a human settles it from evidence.
ALTER TYPE "PaymentIntentStatus" ADD VALUE 'UNCERTAIN';

-- Approved on a card terminal in the store: an acquirer settles it, there is
-- no hosted checkout and no webhook, and a day close reads it as card takings
-- rather than online sales.
ALTER TYPE "PaymentChannel" ADD VALUE 'TERMINAL';

-- Instruments the existing four could not name. A wallet payment recorded as
-- OTHER is indistinguishable from a voucher, and the day close then reports
-- both under one meaningless heading.
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';
ALTER TYPE "PaymentMethod" ADD VALUE 'NETBANKING';
