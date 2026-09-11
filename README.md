# Know Your Numbers

A small-business finance dashboard. Drop in a bank CSV, sort the
transactions into categories, and the monthly totals, the year-at-a-glance
P&L and the cash-flow plan all fall out of the same data.

It runs as a single Node process that serves one page and stores everything
in its own SQLite file. No accounts, no external services, no build step.

---

## The monthly rhythm

The app is built around one repeating loop, and the three tabs across the
top are that loop in order:

**1. Import** — *Monthly View → CSV Import*

Drop in a statement (checking, savings, credit card). The app guesses which
columns are the date, description and amount, and shows you a preview before
anything is saved. If it guessed wrong, or the signs are inverted, fix the
mapping or flip the polarity — then, or any time later. Each file stays a
distinct batch you can inspect or remove on its own.

**2. Categorise and check the month** — *Monthly View → Transactions*

Every transaction lands in a category, and the month's Income, Expenses and
Net sit above the table. Anything the app wasn't sure about is flagged for
review rather than silently filed.

**3. Compare across months** — *Annual View*

The same categories as rows, the twelve months as columns, with subtotals
per group and a running total. This is where a month that looks fine on its
own turns out to be an outlier.

**4. Decide what to do with the cash** — *Cash Flow Waterfall*

Turns the ledger into a plan for three buckets. See below.

---

## How transactions get categorised

In priority order:

1. **What you've already taught it.** If you've categorised a payee before,
   that wins. Descriptions are normalised first, so `TRADER JOE S #453` and
   `TRADER JOE S #118` are recognised as the same merchant.
2. **Income source keywords**, matched against the description.
3. **Expense category keywords**, same.
4. **Otherwise** it's parked as uncategorised and flagged.

A transaction is also flagged when the **sign contradicts the category** —
something matched an income source but is negative, or matched an expense
but is positive. That usually means a refund, a transfer, or an inverted
column, so it's surfaced rather than quietly added up.

### Categories that ship with it

Expenses come pre-loaded in two groups, and the split is not cosmetic — it
decides what counts against taxable profit:

- **Tax deductible expenses** (24) — Advertising & Marketing, Affiliate
  Payments, Bank Fees, Car Expenses, Contractor Payments, Cost of Goods
  Sold, Conferences/Seminars, Coaching, Credit Card Interest, Equipment,
  Insurance, Job Supplies, Legal / Accounting Services, Licenses, Meals,
  Software Expenses, Office Supplies, Rent/ Lease, Payroll, Payroll Taxes,
  Reimbursable Expenses, Stripe/Paypal/Shopify/Square Fee's, Travel,
  Utilities.
- **Non-tax deductible expenses** (4) — Owners distributions, Debt minimum
  payments, Debt extra payments, Estimated Taxes Paid.

> **Income sources start empty, on purpose.** They're yours to name — one
> per client, product line, or platform. Until you add at least one, every
> deposit in an import will be flagged as unmatched. That's expected on a
> first run, not a fault: add your sources in *Categories*, and the keywords
> will pick up the rest.

Everything here is editable. Rename, add and remove categories in
*Monthly View → Categories*; keywords live alongside each one.

---

## Owner's pay

The figure in the header is the current month's **Owners distributions**
total — money moved out of the business to you personally. Because it sits
in the non-deductible group, it doesn't reduce taxable profit.

If you count anything else as owner's pay (payroll to yourself, say), this
figure will read low. It resolves the category by id first and by name
second, so renaming the category is safe; broadening the definition is a
one-line change in `public/ledger.js`.

---

## The cash flow waterfall

Three buckets, with targets derived from your own trailing six months of
tax-deductible expenses:

| Bucket | Target | What it tells you |
|---|---|---|
| **Checking** | 1 month of average expenses | Above the buffer, move the surplus to Working Capital. Below it, leave it alone and let it rebuild. |
| **Working Capital** | 2 months of average expenses | Above target is genuinely spare — distributions or investment. Below target, draw on it only if you need to. |
| **Tax** | You set this one | Compared against what you've set aside. For reference it shows the estimated tax accrued across the same six months. |

Cash only ever sweeps **upward**, from Checking into Working Capital. A
shortfall never pulls money back down — it just refills over time.

The tax target is deliberately yours rather than calculated, so a number
you're confident in isn't overwritten by an estimate. The reference figure
underneath it is gross profit (income less deductible expenses) times your
tax rate, summed over six months, ignoring loss-making months.

---

## Two ledgers

The **Business / Personal** switch at the top is a second, separate ledger
with its own transactions and categories.

**The personal side is a placeholder today.** The switch works and the
screens are laid out, but the business ledger is the one that's built. It's
signposted in the app rather than hidden.

---

## Light and dark

The toggle beside the save indicator switches between the light theme and
the original navy-and-cream one. The choice is remembered per browser, and
applied before the page paints so there's no flash.

---

## How it's put together

```
server.js            Node server: serves the page, plus a small REST API
railway.json         healthcheck + restart policy for Railway
public/
  index.html         markup
  styles.css         all styling, including both themes
  db.js              storage adapter — the page's db.doc() calls over fetch
  shell.js           app chrome: business/personal, tabs, theme, sync status
  ledger.js          the ledger: CSV import, categorising, annual, waterfall
data/app.db          your data (created automatically, git-ignored)
```

`server.js` serves everything under `public/`, so the page must stay at
`public/index.html`.

### Data model

One row per document path holding a JSON blob:

| Path | Holds |
|---|---|
| `biz-months/YYYY-MM` | that month's transactions and import batches |
| `biz-settings/categories` | income sources, expense groups, tax rate |
| `biz-settings/monthsIndex` | `"YYYY-MM"` → transaction count |
| `biz-settings/prefs` | last month viewed |
| `biz-settings/waterfall` | bucket balances and targets |

The API is `GET`/`PUT`/`PATCH`/`DELETE` on `/api/doc/<collection>/<id>`.
Paths need an even number of segments; anything else is rejected with a 400
rather than written somewhere unexpected.

Saves are debounced and the header reports the state — *Saved*, *Saving…*,
or a warning if it can't reach the server.

---

## Running it locally

```
npm install
npm start
```

Then open http://localhost:3000. Needs **Node 24 or newer** — the server
uses the built-in `node:sqlite` module, so there's nothing to compile.

---

## Deploying to Railway

Railway detects Node, runs `npm install`, then `npm start`, and supplies the
port via `$PORT`.

1. **New Project → Deploy from GitHub repo**, and pick this repository.
2. **Add a volume**, mounted at `/data`.
3. **Set `DB_PATH=/data/app.db`** in the service variables.
4. **Generate a domain** under *Settings → Networking*.

### Do steps 2 and 3 before entering real data

Without the volume, `data/app.db` lives on the container's temporary disk and
**every redeploy starts from an empty database**. Pointing `DB_PATH` inside
the mounted volume is what makes the data survive.

To confirm: enter something, redeploy, reload. If it's still there, you're
wired up correctly.

### Custom domain

Railway custom domains need a **CNAME**, and a CNAME can't live on a bare
apex domain. Use `www.yourdomain.com` (or another subdomain) and point the
apex at it with your registrar's forwarding.

---

## Backing up

The whole database downloads as one JSON file:

```
https://<your-app-url>/api/export
```

The volume is the only copy of your data, and a deleted volume has no undo.
Download this now and then.

---

## Health check

`GET /health` queries the database rather than just confirming the process is
listening, so a container that can't read its volume reports unhealthy
instead of serving a broken app. Railway polls it (`railway.json`) and won't
swap a new deploy in until it passes.

---

## No password protection

By request, this deployment has no login — anyone with the URL can open and
edit the data. Treat the URL itself as the thing to keep private.
