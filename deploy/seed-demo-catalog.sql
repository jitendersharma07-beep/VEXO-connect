-- Give the demo tenant a menu it can actually sell from.
--
-- The demo company was deployed with two branches, four staff accounts and an
-- empty catalog: zero tax rates, zero categories, zero products, zero tables.
-- A POS with no menu cannot take an order, so every downstream feature — bill,
-- payment, receipt, KOT, report, refund — is unreachable from the UI. That is
-- the single thing standing between this deployment and a client being able to
-- click through it.
--
-- Scope, enforced below rather than assumed:
--   * writes only into the company whose isDemo = true
--   * catalog and table rows only; no user, licence, order or payment is touched
--   * re-runnable: it inserts nothing that is already there, so running it
--     twice does not produce a duplicate menu
--
-- Receipts print their own "DEMO — sample data, not a real sale" banner off the
-- company's isDemo flag, so the products are named like a real menu instead of
-- being prefixed with DEMO. Marking the paper is the receipt's job; making the
-- menu look like a real café is what lets the client judge the product.

\set ON_ERROR_STOP on

BEGIN;

-- Refuse to touch a real tenant. If no demo company exists, or more than one
-- does, this aborts the transaction instead of guessing which one to fill.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Company" WHERE "isDemo" = true;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one isDemo company, found %', n;
  END IF;
END $$;

CREATE TEMP TABLE _target AS
  SELECT id AS company_id FROM "Company" WHERE "isDemo" = true;

-- --- tax rates -------------------------------------------------------------
-- Two rates because a single rate hides the most common arithmetic bug: a bill
-- that mixes 5% and 18% lines has to total per-line, not by applying one rate
-- to the subtotal.

INSERT INTO "TaxRate" (id, "companyId", name, "ratePercent", status, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t.company_id, v.name, v.rate, 'ACTIVE', now(), now()
FROM _target t
CROSS JOIN (VALUES ('GST 5%', 5.00), ('GST 18%', 18.00)) AS v(name, rate)
WHERE NOT EXISTS (
  SELECT 1 FROM "TaxRate" x WHERE x."companyId" = t.company_id AND x.name = v.name
);

-- --- categories ------------------------------------------------------------

INSERT INTO "Category" (id, "companyId", name, "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t.company_id, v.name, v.ord, now(), now()
FROM _target t
CROSS JOIN (VALUES
  ('Hot Coffee', 10),
  ('Cold Coffee', 20),
  ('Tea', 30),
  ('All Day Breakfast', 40),
  ('Sandwiches & Rolls', 50),
  ('Desserts', 60),
  ('Packaged & Retail', 70)
) AS v(name, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM "Category" x WHERE x."companyId" = t.company_id AND x.name = v.name
);

-- --- products --------------------------------------------------------------
-- Prices are the round-ish numbers a Delhi café actually charges, and several
-- are deliberately not round (185, 265) so a percentage tax produces a value
-- that needs real rounding rather than one that comes out exact either way.
--
-- Packaged & Retail carries 18% and everything else 5%, which is the split a
-- café genuinely has and the reason the two rates exist above.

INSERT INTO "Product" (id, "companyId", "categoryId", name, sku, "basePrice", "taxRateId", status, "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t.company_id,
  c.id,
  v.name,
  v.sku,
  v.price,
  (SELECT x.id FROM "TaxRate" x WHERE x."companyId" = t.company_id AND x.name = v.tax),
  'ACTIVE',
  now(), now()
FROM _target t
CROSS JOIN (VALUES
  ('Hot Coffee',          'Espresso',                 'BS-HC-01', 140.00, 'GST 5%'),
  ('Hot Coffee',          'Americano',                'BS-HC-02', 165.00, 'GST 5%'),
  ('Hot Coffee',          'Cappuccino',               'BS-HC-03', 185.00, 'GST 5%'),
  ('Hot Coffee',          'Cafe Latte',               'BS-HC-04', 195.00, 'GST 5%'),
  ('Hot Coffee',          'Filter Coffee',            'BS-HC-05', 120.00, 'GST 5%'),
  ('Cold Coffee',         'Iced Americano',           'BS-CC-01', 185.00, 'GST 5%'),
  ('Cold Coffee',         'Cold Brew',                'BS-CC-02', 225.00, 'GST 5%'),
  ('Cold Coffee',         'Frappe',                   'BS-CC-03', 265.00, 'GST 5%'),
  ('Tea',                 'Masala Chai',              'BS-TE-01',  90.00, 'GST 5%'),
  ('Tea',                 'Green Tea',                'BS-TE-02', 110.00, 'GST 5%'),
  ('Tea',                 'Lemon Iced Tea',           'BS-TE-03', 145.00, 'GST 5%'),
  ('All Day Breakfast',   'Masala Omelette',          'BS-BF-01', 235.00, 'GST 5%'),
  ('All Day Breakfast',   'Poha',                     'BS-BF-02', 165.00, 'GST 5%'),
  ('All Day Breakfast',   'Pancake Stack',            'BS-BF-03', 285.00, 'GST 5%'),
  ('Sandwiches & Rolls',  'Grilled Veg Sandwich',     'BS-SR-01', 225.00, 'GST 5%'),
  ('Sandwiches & Rolls',  'Chicken Tikka Roll',       'BS-SR-02', 265.00, 'GST 5%'),
  ('Sandwiches & Rolls',  'Paneer Kathi Roll',        'BS-SR-03', 245.00, 'GST 5%'),
  ('Desserts',            'Chocolate Brownie',        'BS-DS-01', 175.00, 'GST 5%'),
  ('Desserts',            'New York Cheesecake',      'BS-DS-02', 295.00, 'GST 5%'),
  ('Desserts',            'Tiramisu',                 'BS-DS-03', 315.00, 'GST 5%'),
  ('Packaged & Retail',   'Coffee Beans 250g',        'BS-PK-01', 650.00, 'GST 18%'),
  ('Packaged & Retail',   'Brew Street Mug',          'BS-PK-02', 450.00, 'GST 18%'),
  ('Packaged & Retail',   'Cold Brew Bottle 500ml',   'BS-PK-03', 320.00, 'GST 18%')
) AS v(cat, name, sku, price, tax)
JOIN "Category" c ON c."companyId" = t.company_id AND c.name = v.cat
WHERE NOT EXISTS (
  SELECT 1 FROM "Product" x WHERE x."companyId" = t.company_id AND x.sku = v.sku
);

-- --- dining tables ---------------------------------------------------------
-- Per branch, so the table list is one of the places where branch scoping is
-- visible on screen rather than only in the API.

INSERT INTO "DiningTable" (id, "branchId", name, capacity, status, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, b.id, v.name, v.cap, 'ACTIVE', now(), now()
FROM _target t
JOIN "Branch" b ON b."companyId" = t.company_id
CROSS JOIN (VALUES
  ('T1', 2), ('T2', 2), ('T3', 4), ('T4', 4),
  ('T5', 4), ('T6', 6), ('Counter 1', 1), ('Counter 2', 1)
) AS v(name, cap)
WHERE NOT EXISTS (
  SELECT 1 FROM "DiningTable" x WHERE x."branchId" = b.id AND x.name = v.name
);

COMMIT;

-- Read the result back from the database rather than trusting the row counts
-- the inserts reported, and break it down per branch so a table list that
-- landed on only one branch is visible instead of averaged away.
SELECT
  (SELECT count(*) FROM "TaxRate"  x JOIN "Company" c ON c.id = x."companyId" WHERE c."isDemo") AS tax_rates,
  (SELECT count(*) FROM "Category" x JOIN "Company" c ON c.id = x."companyId" WHERE c."isDemo") AS categories,
  (SELECT count(*) FROM "Product"  x JOIN "Company" c ON c.id = x."companyId" WHERE c."isDemo") AS products,
  (SELECT count(*) FROM "DiningTable" x JOIN "Branch" b ON b.id = x."branchId"
     JOIN "Company" c ON c.id = b."companyId" WHERE c."isDemo") AS tables;

SELECT b.name AS branch, count(d.id) AS tables
FROM "Branch" b
JOIN "Company" c ON c.id = b."companyId" AND c."isDemo"
LEFT JOIN "DiningTable" d ON d."branchId" = b.id
GROUP BY b.name ORDER BY b.name;
