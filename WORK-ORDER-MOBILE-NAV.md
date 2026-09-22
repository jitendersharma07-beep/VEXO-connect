# Work order — navigation below 768 px

**For the frontend lane (`atc-pos-lanes/frontend`, branch `phase2-frontend`).**
Raised by the release-verify lane, which does not edit frontend files.

Tracked in the handover pack as limitation **§6.12**. It is the last open
layout defect and the only one that makes a screen unusable rather than ugly.

## The defect, precisely

`frontend/src/components/Layout.jsx:137`

```jsx
<aside className="hidden w-60 flex-col bg-pos-deep px-4 py-5 md:flex">
```

The sidebar is the only navigation in the product. Below Tailwind's `md`
breakpoint it is `hidden`, and nothing replaces it — the header at line 218
renders a bare `<Logo />` and no control that opens anything.

Measured on the deployed bundle across twelve widths: at **768 px** a cashier
on the Sell screen has **4** nav links; at **767 px** they have **0**.

What makes this easy to miss: the page does not *look* broken. There is no
horizontal overflow even at 320 px, the product grid reflows, the order panel
is fine. It is simply a dead end — a cashier on a phone cannot reach Orders to
reprint a bill, and cannot sign out of a stuck till.

## What to build

A menu control visible below `md` that opens the existing navigation.

**Render the same `<nav>` children, do not retype them.** Lines 139–211 are
role-conditional in three ways — `isAtc`, `atcScope`, and the regular POS
tree — and a hand-copied duplicate will drift from the original the first time
someone adds a link. Worse than drift: a duplicate that hardcodes the full list
hands a cashier the owner's links. Lift the nav body into one component and
render it in both places.

Also close the drawer on route change. A cashier taps Orders, the page
navigates behind an open drawer, and they tap again.

`Layout.jsx` should be the only file that needs to change.

## Evidence to submit

Screenshots, from the built bundle, signed in — not a dev-server fixture.

| Width | Signed in as | Must show |
|---|---|---|
| 430 × 932 | cashier | menu control visible; opened drawer reachable |
| 430 × 932 | cashier, drawer open | **Sell and Orders only** — no Catalog, Team, Sales report, Daily closing |
| 430 × 932 | owner, drawer open | the full owner tree |
| 767 × 1024 | cashier | navigation reachable — this is the width that had zero |
| 768 × 1024 | cashier | unchanged from today; the sidebar still renders as a sidebar |

Plus two numbers per width, which is what turns a screenshot into a check:

- `document.documentElement.scrollWidth - clientWidth` — must stay `0`. The
  no-overflow property is currently true at every width down to 320 px and
  must survive the fix.
- count of visible `a[href^="/pos/"]` — must be `> 0` at 430 px and at 767 px,
  and must be **smaller for the cashier than for the owner** at the same width.

That last comparison is the one that matters. It is the only check here that
fails if the drawer is wired to a hardcoded link list instead of the real
role-gated one, and that failure mode is a permissions leak, not a layout bug.

## After it lands

Release-verify rechecks the integrated build: merge to the release branch,
rebuild, redeploy, and re-measure the same widths against the bundle pulled
back out of the running container — not against the working tree, which builds
a different artefact. Handover §6.12 gets rewritten from a limitation into a
fix with its measurement, the same way §6.8, §6.9 and §6.13 were.

Until that recheck passes, §6.12 stands as written and the supervised-demo
condition "confirm the till screen is ≥ 768 px wide" stays in force.
