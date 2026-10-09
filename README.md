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

Pick one in `server/.env`:

1. **`SHEET_SOURCE=csv`** (simplest). Set `SHEET_ID` and share the sheet as "Anyone with the link can view". Optionally set `SHEET_ORDER_GID` / `SHEET_MASTER_GID` (the number after `gid=` in each tab's URL).
2. **`SHEET_SOURCE=api`** for a private sheet. Create a Google service account, enable the Sheets API, share the sheet with the service account email as Viewer, and set `GOOGLE_SERVICE_ACCOUNT_FILE` (or `_JSON`).
3. **`SHEET_SOURCE=none`**: upload CSV exports from Settings.

Then open **Settings** and press **Sync now**. `SYNC_INTERVAL_MIN` syncs automatically. Set `ACCESS_PASSWORD` to put the dashboard behind a shared key (recommended, the data holds customer names).

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
