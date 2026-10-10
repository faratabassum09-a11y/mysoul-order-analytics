# MySoul Order Analytics: Step 1

MERN app that reads the **Order Sheet** tab of the "Shopify New Order" Google Sheet, cleans a copy in MongoDB, and shows confirmation, cancellation, dispatch, NDR, RTO and net delivered revenue for any window, split by COD / Partial COD / Prepaid.

The app never writes to the Google Sheet. Every cleaning decision is logged per row and visible in the Orders screen.

## Run it

Needs Node 18+ and MongoDB.

```bash
npm run install:all
cp server/.env.example server/.env      # then edit (see below)
npm run dev:server                      # API on :4000
npm run dev:client                      # UI on :5173 (proxies /api)
```

Production: `npm run build && npm start` serves the UI and API together on port 4000. `docker compose up --build` also works (put your settings in `server/.env`).

Tests for the cleaning rules, metric formulas and time windows: `npm test`.

## Connect the sheet

Easiest: open **Settings → Connect Google Sheet**, paste the link of the Order Sheet tab, and press **Save and sync**. The link is stored in the database, so no server restart or environment variables are needed. The sheet must be shared as "Anyone with the link → Viewer". The environment variables below are an alternative.

Pick one in `server/.env`:

1. **`SHEET_SOURCE=csv`** (simplest). Set `SHEET_ID` and share the sheet as "Anyone with the link can view". Optionally set `SHEET_ORDER_GID` / `SHEET_MASTER_GID` (the number after `gid=` in each tab's URL).
2. **`SHEET_SOURCE=api`** for a private sheet. Create a Google service account, enable the Sheets API, share the sheet with the service account email as Viewer, and set `GOOGLE_SERVICE_ACCOUNT_FILE` (or `_JSON`).
3. **`SHEET_SOURCE=none`**: upload CSV exports from Settings.

Then open **Settings** and press **Sync now**. After that nothing needs uploading: see *Automatic sync* below. Set `ACCESS_PASSWORD` to put the dashboard behind a shared key (recommended, the data holds customer names).

## Automatic sync (no daily uploads)

New orders reach the dashboard on their own, within about 15 minutes of landing in the sheet.

- **Built-in timer.** The server pulls the sheet every `SYNC_INTERVAL_MIN` minutes (default **15**, `0` turns it off). If the sheet has not changed since the last pull, cleaning is skipped. A failed Google request is retried twice; a hung request is cut off after 45 s, so one bad run never blocks the next.
- **No empty moments.** Cleaned orders are swapped in row by row and old rows removed afterwards, so the dashboard never shows a half-empty table during a sync, and a failed sync leaves the previous data in place.
- **Hosts that sleep (Render free plan).** A sleeping server cannot run its own timer. Set `CRON_SECRET` on the server and have something call `GET /api/cron/sync` with header `x-cron-key: <secret>` (or `?key=<secret>`) every 5 to 10 minutes. This also keeps the server awake. Call the **server** URL directly, not the Vercel one.
  - **Easiest:** a free [cron-job.org](https://cron-job.org) job every 5 minutes (the endpoint answers at once and skips if the last check was under `CRON_MIN_AGE_MIN`, default 5, minutes ago).
  - **Zero new accounts:** `.github/workflows/sync-sheet.yml` already runs every 15 minutes. Add repo secrets `SYNC_URL` and `CRON_SECRET`. GitHub can delay scheduled runs by several minutes, so prefer cron-job.org if you need it tight.
- **Watching it.** The sidebar shows "Sheet checked N min ago" and turns red if the sync falls behind. Settings shows last check, last data update and any error.
- The Shopify date backfill is a one-time upload. Everything else comes from the sheet.

## Instant sync (seconds, not minutes)

1. Set `CRON_SECRET` on the server (any long random string).
2. Open the Google Sheet > Extensions > Apps Script, paste `apps-script/sheet-instant-sync.gs`, fill in `SERVER_URL` and the same `CRON_SECRET`, and run `setup` once.
3. From then on every change in the sheet calls `POST /api/webhook/sheet`. The server waits 2 seconds (so a burst of edits becomes one sync), pulls the sheet, and re-cleans only if something changed. Open dashboards check for new data every 10 seconds and refresh themselves without a page reload.

The 5-minute trigger the script also creates is a safety net, and it keeps a sleeping free host awake. The 15-minute server timer stays on as a third layer. Changes made *by an Apps Script* do not fire `onChange` (a Google rule); if your orders are added that way, call `notifyServer()` at the end of that script.

## No access to edit the sheet? Use fast polling

The Apps Script needs someone with editor access to install it. Without that, let the server look at the sheet more often: set `SYNC_INTERVAL_MIN=1` (half a minute works too: `0.5`). New orders then appear within about a minute. Unchanged sheets cost almost nothing because cleaning is skipped. On a host that sleeps, also ping `/api/cron/sync` every minute (cron-job.org) with `CRON_SECRET` and `CRON_MIN_AGE_MIN=1`.

## Dates: first job

Order date comes from, in order: Order Sheet column A (year set to 2026, rolled back a year if it would land in the future) → OrdersMaster Timestamp → Shopify orders CSV (Settings → Backfill dates). Orders with none are **undated**: counted in All time, left out of dated windows, and the count is shown at the top of every screen. Upload the Shopify export once to fill #1023 to #1202.

## Cleaning rules (server/src/lib/clean.js)

As in the brief: order ID trimmed and stored as an integer; one record per ID (row with most filled status columns kept); test orders (amount under Rs 100, name containing a word starting with "test", notes = "test") excluded; payment mode normalised; Instransit / In Transit merged, Dispatch-Today kept as Ready to Ship; final status first-match-wins (RTO → Delivered → In Transit → Confirmed → Cancelled → Pending confirmation); NDR kept as a separate flag; URLs in Items moved to Order Link with product Unknown; phones reduced to the last 10 digits, emails split out, and phone hidden by default (revealed per order on request, never in the CSV export).

Interpretation choices worth knowing:
- *Dispatch %* counts dispatched orders among those confirmed Yes, so it shows confirmed orders that are stuck.
- *Dispatched* means Dispatch Status = Yes or a final status of In Transit / Delivered / RTO.
- *Last 3/6/12 months* are rolling windows ending today. *This week/month* compare with the previous calendar week/month; the others compare with the equal-length block before.
- Confirmation and cancellation use the Order Confirmed column, so an order that is Cancel but dispatched still counts as a cancellation (and is listed under Conflicting statuses).

## Where Steps 2 to 4 plug in

- `Order` already stores `orderId` as an integer (the join key for Shopify and the courier), plus `pincode` and `masterTags` from OrdersMaster, and `product` (Unknown until Step 2).
- `lib/metrics.js` computes from plain order objects, so a Shopify line-item or courier-sourced field can be added and grouped without touching the formulas.
- Add new sources as modules next to `services/sources.js` and call them from `services/sync.js`; add routes in `routes/api.js`.

## Layout

```
server/src/lib       clean, metrics, windows, reasons, IST time (pure, tested)
server/src/services  sheet fetching, sync
server/src/routes    REST API
client/src/pages     Overview, Trends, Payment mode, Reasons, Orders, Data issues, Settings
```
