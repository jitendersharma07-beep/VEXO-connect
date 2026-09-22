# Manual browser UAT — one pass, by hand

For when the automated harness cannot be run. Same ground, same evidence
standard: **drive the screen, then read the effect out of the database.** A
screenshot of a screen that says "Paid" is not proof that anything was paid.

One person, one browser, about twenty minutes. Everything lands on the
reserved demo till.

---

## Before you start

**Sign in at** `https://atcworkspace.com/pos/login`

**As** `demo.owner@atcpos.example` — role `CUSTOMER_OWNER`, not bound to a
branch, so it is the only one of the three demo accounts that can select Cyber
Hub at all. `demo.manager@` and `demo.cashier@` are both pinned to Connaught
Place and cannot reach the reserved till. Using the owner also means this run
creates no account and changes no password.

**Where the password lives.** Not in this repo. It **is** on this host, at
`/home/atc-noc/pos-demo-creds-20260921.txt` (mode `0600`, tab-separated
`email<TAB>password`), written by the `--demo` rotation on 2026-09-21 and read
programmatically by `deploy/provision-cyberhub-staff.mjs` via `CREDS_FILE`.

> This paragraph previously said the password was "not in any file on this
> host". That was wrong, and wrong in the expensive direction: the next reader
> would have followed the instruction below and rotated a password that three
> other scripts and at least one other lane are already using. A file that
> several tools read is not an out-of-band secret, however much one would
> prefer it to be. Read it with `cut -f2` in a subshell — do not `cat` it,
> because scrollback gets pasted.

Rotate only if that file is genuinely absent or its password no longer
authenticates. Do not guess, and do not read it out of the database (it is an
argon2 hash; there is nothing to read). Set a fresh one without it ever
reaching a screen, a log or a shell history:

```sh
docker exec -it pos-prod-backend-1 node scripts/rotate-pos-passwords.mjs \
  --emails demo.owner@atcpos.example --demo --prompt --confirm
```

`--prompt` reads it from the terminal with echo off, so nothing is generated
and nothing is written down. `--demo` is correct *here and only here*: it
clears the forced-change flag, which is what you want for a shared demo login
and what you must never do to a real client account. It cannot be applied to
`pos.admin`. Run without `--confirm` first — that previews and writes nothing.

> A 400 from `/api/auth/login` is a malformed request body, **not** a wrong
> password. Wrong credentials return 401. Do not rotate anything on a 400.

**The till.** `Brew Street Café — Cyber Hub` (`BSC-CH`). Reserved in
`UAT-TILL-RESERVATION.md`. Recheck it is still untouched today, and get the
business date, in one command:

```sh
docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos -tA <<'SQL'
select 'business date ' || to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD')
    || ' · BSC-CH orders today ' || (select count(*) from "Order" o join "Branch" b on b.id=o."branchId"
         where b.code='BSC-CH' and (o."createdAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date
             = (now() at time zone 'Asia/Kolkata')::date)
    || ' · closings today ' || (select count(*) from "DayClose" d join "Branch" b on b.id=d."branchId"
         where b.code='BSC-CH' and d."businessDate" = to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD'));
SQL
```

**Both counts must be 0.** If they are not, stop — a closing filed here would
cover trade you did not create.

> ⚠️ **The one trap.** On **Sell**, the owner's Branch dropdown (`#sell-branch`)
> defaults to the *first* branch, which is Connaught Place. **Change it to
> Cyber Hub before clicking any product.** Get this wrong and the whole run
> lands on the wrong branch and cannot be undone.

Capture a screenshot at every step. Name them `m01…m09`.

---

## 1 · Sale

Sell → set Branch to **Cyber Hub** → **Takeaway** → click any product twice.

**Expect:** an order panel opens on the right; the line shows qty **2**; a
subtotal appears.

```sh
docker exec -i pos-prod-postgres-1 psql -U atc_pos -d atc_pos -tA -c \
"select 'order ' || o.id || ' status ' || o.status || ' qty ' || (select sum(qty) from \"OrderItem\" i where i.\"orderId\"=o.id and i.status='ACTIVE')
 from \"Order\" o join \"Branch\" b on b.id=o.\"branchId\" where b.code='BSC-CH' order by o.\"createdAt\" desc limit 1;"
```

✅ exactly one order, status `OPEN`, qty `2`. Keep the order id.

## 2 · KOT

Press **Send KOT**.

**Expect:** a confirmation, and the items stop being editable as a new ticket.

```sh
… -c "select count(*) from \"Kot\" where \"orderId\"='<ORDER_ID>';"
```

✅ `1` or more. **A KOT that prints nothing still counts here** — physical
printing is separately untested and stays that way until there is a printer.

## 3 · Bill

Press **Bill**.

**Expect:** an invoice number appears, format `BSC-CH/26-27/000NN`.

```sh
… -c "select status || ' ' || coalesce(\"invoiceNumber\",'-') || ' ₹' || total from \"Order\" where id='<ORDER_ID>';"
```

✅ status `BILLED`, invoice number present. **Check the total by hand**: unit
price × 2, plus the GST rate shown on the line. Arithmetic nobody checks is
arithmetic nobody has checked.

## 4 · Payment — and the duplicate-click check

Press **Record payment**.

**Expect first:** the dialog says the payment is being **recorded manually**.
It must not claim anything was verified by a provider. There must be no
**Pay online** button anywhere — the gateway is off for this pilot.

Press **Exact**, then press the submit button **twice, fast**.

```sh
… -c "select count(*) || ' payment(s) ₹' || coalesce(sum(amount),0) || ' ' || coalesce(max(method::text),'-') || '/' || coalesce(max(channel::text),'-') from \"Payment\" where \"orderId\"='<ORDER_ID>';"
… -c "select status from \"Order\" where id='<ORDER_ID>';"
```

✅ **exactly one** payment row, amount = the bill total, channel `MANUAL`,
order status `PAID`. Two rows here is a genuine defect — stop and report it.

## 5 · Refund

Orders → open the invoice → **Refund** → amount `10`.

**Expect first:** with the reason box empty the confirm button is **disabled**.
Type a reason (`Manual UAT — partial refund`) and it arms. That refusal is the
check; do not skip past it.

```sh
… -c "select count(*) || ' refund(s) ₹' || coalesce(sum(amount),0) || ' ' || coalesce(max(channel::text),'-') || '/' || coalesce(max(status::text),'-') from \"Refund\" where \"orderId\"='<ORDER_ID>';"
```

✅ one refund, ₹10.00, channel `MANUAL`, status `SUCCEEDED`.

## 6 · Report

Sales report → From and To both = today → Branch = **Cyber Hub**.

**Expect:** the order appears; collected reflects the payment; the refund is
shown as a refund, not netted away silently.

```sh
… -c "select 'collected ₹' || coalesce(sum(p.amount),0) from \"Payment\" p join \"Order\" o on o.id=p.\"orderId\" join \"Branch\" b on b.id=o.\"branchId\" where b.code='BSC-CH' and (p.\"createdAt\" at time zone 'UTC' at time zone 'Asia/Kolkata')::date=(now() at time zone 'Asia/Kolkata')::date;"
```

✅ the figure on screen equals the figure from the database.

**Negative control — do this one.** Change the range to `2020-01-01` →
`2020-01-02`. The figures must **disappear**. If today's numbers are still
sitting there, the report is not reading the range and step 6 proved nothing.

## 7 · Day close

Daily closing → Date = today → Branch = **Cyber Hub**.

**Expect:** a drawer-count form and an expected-cash figure.

**First, the control.** Type `1` into *Cash counted*, leave the note empty.
The close button must be **disabled**. Add any note — it arms. That is the
variance gate working.

**Then file it properly.** Set *Cash counted* to the expected-cash figure the
screen shows, float `0`, note `Manual UAT — drawer counted against this run`.
Submit once.

```sh
… -c "select id || ' counted ₹' || (\"countedCashPaise\"/100.0) || ' expected ₹' || (\"expectedCashPaise\"/100.0) || ' variance ₹' || (\"variancePaise\"/100.0)
 from \"DayClose\" d join \"Branch\" b on b.id=d.\"branchId\" where b.code='BSC-CH' and d.\"businessDate\"=to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD');"
```

✅ exactly one row; counted = what you typed; variance `0.00`.

## 8 · Reload and re-read the saved closing

**Reload the page** (F5), set Date = today and Branch = **Cyber Hub** again.

**Expect** the amber banner:

> This day was already closed by **&lt;your name&gt;** at &lt;time&gt; — counted
> **₹&lt;amount&gt;**, variance nil. Filing again records a correction; the
> original stays on the record.

✅ the name is yours, the amount matches step 7, the time is when you filed it.

> 🛑 **Do not submit again.** A second submission files a *correction* — a
> second permanent record. "Reopened" here means read the saved record back
> after a fresh load. It does not mean reopening a closed till, and this
> product deliberately does not offer that.

---

## What to hand back

- The nine screenshots.
- The SQL output from every step, pasted as-is.
- For each step: PASS, FAIL, or NOT TESTED — **not** a general impression.
- Anything that looked wrong but passed. Those are the useful ones.

## Known NOT TESTED regardless of outcome

| | Why |
|---|---|
| Physical receipt / KOT printing | no printer attached to this deployment |
| Razorpay checkout, webhook, refund | gateway off for a billing-only pilot; another lane owns it |
| Any screen below 768 px | no navigation exists there yet — `WORK-ORDER-MOBILE-NAV.md` |
| Day-close correction chain | would file a second permanent record; covered by the vitest suite |

## If a step fails

Stop at the first failure and capture the screen, the SQL output, and the
browser console. Do not retry — a retry on a half-written order is a second
defect on top of the first, and the database state at the moment of failure is
the most useful thing you have.
