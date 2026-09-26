# Peer note — `reportingApi.test.js` fails for six hours of every day

**From:** the cloud-readiness / first-login lane
**To:** the reporting lane — `x/reporting`, worktree
`/home/atc-noc/vexo-connect-x-lanes/reporting`, owner of `969e2af`
**Date:** 2026-09-26
**Nothing in your lane has been edited.** The fix below was applied and run in my
own scratch worktree only. Fold it in, reword it, or reject it — your call.

## The short version

`backend/tests/reportingApi.test.js` fails **4 of 36** whenever the box clock is
between **12:30 and 18:30 UTC** (18:00–24:00 IST). That is **six hours a day,
25% of the clock** — and on an IST-hours team it is most of the working
afternoon.

**Your application code is correct. The test is timezone-naive.** I am not
suggesting a change to `period.js`.

I found this because the flake landed in my lane's integration run and I had to
prove it was not my first-login gate before I could report the run honestly. It
is not — it reproduces on plain `main` with none of my code in the tree.

## Which tests, and what they report

| Test | Assertion when it fails |
|---|---|
| `the figures reconcile > sales, collections and refunds are separately explainable` | `expected +0 to be 1` |
| `the figures reconcile > a part-paid bill appears as a due, not as a missing sale` | `[]: expected undefined to be truthy` |
| `the figures reconcile > collections split by method rather than collapsing into one figure` | `expected [] to include 'CASH'` |
| `the export is the payload > the CSV carries the same net sales as the JSON payload` | `Cannot read properties of null (reading 'paise')` |

Every one is a "no rows came back" symptom, which is what makes it look like a
data-layer bug rather than a clock bug.

In your tree those are lines **567**, **590**, **599** and **635**.

## The mechanism

Your fixture helper places all the money fixtures 18 hours in the past:

```js
// your line 183 — main-merge line 135
const yesterdayAfternoon = () => new Date(Date.now() - DAY + 6 * 3600e3);
```

There is one call site (your line **302**, `const at = yesterdayAfternoon()`),
and every `billedAt` in the reconcile block comes from it.

The tests then query `preset=YESTERDAY`. The server resolves that preset **in
the company's reporting timezone** — `Asia/Kolkata`, `src/lib/reporting/period.js:18`
— while the box runs UTC. Your own test asserts that default at line **714**
(`expect(res.body.timezone).toBe('Asia/Kolkata')`), so the app is doing exactly
what it is specified to do.

`now − 18h` is only "yesterday" in IST while IST wall-clock is before 18:00.
Past that, `now − 18h` lands on **today** in IST, `YESTERDAY` selects a day the
fixtures never touched, and every reconcile assertion reports an empty result.

Written as a boundary: the fixture and the preset agree only while UTC
time-of-day is outside **[12:30, 18:30)**.

## Evidence

Three independent checks, because "it's a clock thing" is easy to assert and
worth proving:

| Check | Result |
|---|---|
| Same 4 fail on plain `main` `728a57c`, no unrelated lane code present | **Yes** — 4 failed / 32 passed, exit 1, same names, same assertions |
| Same file, same commit, same DB, process clock moved back 3h | **36 / 36, exit 0** |
| Cutoff bisected by shifting the clock rather than derived on paper | fails at an effective **12:34 UTC**, passes at **12:28 UTC** |

And the 24-hour sweep, sampling every 5 minutes (288 points): the current helper
disagrees with the `YESTERDAY` preset on **72 of 288** samples — exactly the six
hours above.

## Suggested fix

Derive the fixture from the reporting timezone instead of from a fixed offset.
One helper, no call-site changes, no production code touched:

```js
// Mid-afternoon yesterday: safely inside the business day whichever way the
// cutoff is set, so these fixtures never sit on a boundary by accident.
//
// Derived from the reporting timezone, not from `Date.now() - 18h`. The server
// resolves the YESTERDAY preset in the company timezone (period.js), so a
// fixture placed 18 hours back lands on TODAY in IST whenever the box clock is
// past 12:30 UTC — six hours a day on a UTC host, during which these tests
// query a day they put no data on.
const REPORT_TZ = 'Asia/Kolkata';
const yesterdayAfternoon = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Date.now() - DAY));
  const part = (type) => parts.find((p) => p.type === type).value;
  // IST is UTC+5:30 with no DST, so 14:00 IST is 08:30 UTC on the same date.
  return new Date(`${part('year')}-${part('month')}-${part('day')}T08:30:00.000Z`);
};
```

### Proven, not just proposed

Applied to a scratch copy of the merged file and run against the same database:

| When | Result |
|---|---|
| **14:24 UTC** — inside the window where the current helper fails 4 | **36 / 36, exit 0** |
| 10:24 UTC — outside it | **36 / 36, exit 0** |
| 05:24 UTC — outside it | **36 / 36, exit 0** |
| 24-hour sweep, 288 samples, arithmetic | **0 disagreements** (current helper: 72) |

The two shifted runs are the regression direction — they confirm the fix does
not break the eighteen hours that already work.

### One thing to decide that I should not decide for you

I hard-coded `Asia/Kolkata` in the helper to match the company default your
suite already asserts. If you would rather the fixture follow whatever timezone
the test company is configured with, that is a better-factored fix and it is
your call — the tests at lines 714–725 already exercise changing it, so there is
a precedent either way. The version above is the minimal change that makes the
suite honest about the clock.

## Why it is worth doing rather than living with

- It is **not** a flaky-test-rerun situation. It is deterministic: green before
  12:30 UTC, red after. A rerun at 15:00 UTC fails every time.
- It will read as a **reporting regression** to whoever hits it next. All four
  symptoms look like missing data, and the first instinct is to go looking at
  the query layer — which is where I would have gone if the failure had not
  landed in a lane that touches no reporting file at all.
- It blocks clean integration runs for everyone, not just you. My 53-file run
  exited 1 on these four and nothing else.

I have recorded the same finding in
`WINDOW-1-FIRSTLOGIN-SHA.md` under "`reportingApi.test.js` fails after 12:30
UTC", flagged as yours to fix and explicitly **not** a blocker on `bad4896`.

Raw logs, if you want them, are on this box at
`/home/atc-noc/vcx-cloudready-local/`:
`control-reportingApi-main-728a57c.log` (the plain-`main` reproduction),
`control-reportingApi-main-shift3h.log` (the clock-shifted pass), and
`fix-reportingApi-tzhelper.log` (this fix at 14:24 UTC).
