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

Then open **Settings** and press **Sync now**. After that nothing needs uploading: see *Automatic sync* below. The dashboard is open only to people signed in with their own team login (see *Team logins* below); there is no shared password.

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

## Shopify: customer details and items per order

Every sheet order is matched by its number (`#1300` is 1300) to the same order in Shopify. The Orders screen then shows the items (in the table and in the order drawer), the customer name and city, and, behind the **Reveal** button, phone, email and the full address, as the sheet's own phone and email already do.

There are two ways to give the server access. Which one applies depends on whether your **store is listed under Stores in the Dev Dashboard** (dev.shopify.com/dashboard):

- **Store not listed (the usual case for a normal store): install link.** Steps below.
- **Store listed in the same organization as the app:** no install link is needed. Create the app, add the scopes, install it on the store, copy the Client ID and secret into the server settings, and press **Test connection**. The server logs in by itself.

**Setup with the install link (about 15 minutes)**
1. Dev Dashboard, **Create app** (start from the Dev Dashboard), for example "MySoul Order Analytics".
2. Create a version. Access scopes: `read_orders` and `read_customers`. Under **Redirect URLs** add `https://YOUR-SERVER/api/shopify/callback` (Settings, Shopify card shows the exact address). **Release** the version. The App URL can stay at its default.
3. Distribution: choose **Custom distribution** (permanent, fine for one store), enter the store's `your-store.myshopify.com` address and generate the **install link**.
4. The store owner opens the install link while signed in to the Shopify admin and installs the app.
5. Dev Dashboard, the app's **Settings**: copy the Client ID and Client secret. On the server (Render, Environment) set `SHOPIFY_SHOP` (the part before `.myshopify.com`), `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`. Save and let it redeploy. Never put them in git.
6. In the dashboard: Settings, Shopify card, **Connect Shopify**. Shopify asks the owner to approve, then returns to a "Shopify is connected" page and the first load of all orders starts.

**How it runs.** The approval gives the server an access token that Shopify expires after a short time. It is renewed automatically with a refresh token kept in your database. If the connection is ever lost (app removed from the store, or the server was off for months), Settings says so and **Connect Shopify** fixes it in one click. New and changed orders are pulled every 2 minutes (`SHOPIFY_SYNC_INTERVAL_MIN`) and immediately after the sheet brings something new. Opening an order that is not loaded yet fetches it on the spot. Shopify's rate limit is handled by waiting, not failing.

**Good to know**
- By default Shopify only releases the **last 60 days** of orders to an app. Older orders need the `read_all_orders` permission, which Shopify must approve (request it in the Dev Dashboard). Once approved, add it to the app version, set `SHOPIFY_SCOPES=read_orders,read_customers,read_all_orders` on the server, and press Reconnect Shopify. Until then, older orders show "no Shopify data", and the CSV date backfill stays available for their dates.
- The order date from Shopify also fills the "undated" sheet rows automatically, replacing the CSV upload for every order Shopify releases.
- If names or emails come back empty, check that `read_customers` is on the released app version. Test connection reports it.
- The access token and customer details are stored in your own MongoDB. Only signed-in admins can open the dashboard.
- The Shopify API version is set by `SHOPIFY_API_VERSION` (default `2026-04`). Shopify retires old versions after about a year.

## Shipway: dispatch and tracking status per order

Orders are dispatched from Shipway, so every order has **two statuses, shown separately**: the one from the sheet ("Sheet status") and the one from Shipway ("Shipway status"). Nothing is merged and the Overview, Trends and Payment mode numbers still come from the sheet. In **Orders**, both appear as columns, the Shipway one can be filtered (including "Not in Shipway"), and the order drawer shows courier, AWB, last update and the status changes the dashboard has seen. The CSV export gains Shipway status, courier and AWB.

**Setup (2 minutes)**
1. Shipway, **Profile, Manage profile**: copy the **licence key**. The API uses the licence key, not the login password.
2. On the server (Render, Environment) set `SHIPWAY_USERNAME` (the Shipway login email) and `SHIPWAY_LICENSE_KEY`. Never put them in git or in a chat.
3. Redeploy. In **Settings, Shipway**, press **Test connection**, then **Check all orders**.

**How it works.** For each order the server calls Shipway's *Order Shipment Details* (`/api/getOrderShipmentDetails`) with the order number. Newest orders go first. Delivered, RTO-delivered, cancelled and lost shipments are not asked again; moving shipments are re-checked after 30 minutes, orders Shipway does not know yet after 3 hours (for 30 days). The timer runs every `SHIPWAY_SYNC_INTERVAL_MIN` minutes (default 10); opening an order refreshes it if its saved status is more than 10 minutes old.

**Order numbers.** Shipway must hold the order under the number the dashboard uses (1874 or #1874). `SHIPWAY_ORDER_ID_FORMAT=auto` (default) tries both and remembers which works. **Test connection** looks up a recent order and says which form matched; if Shipway has none of the newest orders, it says so.

**Good to know**
- Shipway's reply carries only the latest status, so the "changes seen" list starts from the moment the dashboard first sees each order.
- A lookup that comes back empty never erases a status already saved.
- Customer name and phone in Shipway's reply are not stored.
- Not used: Shipway webhooks. Their payload is not in the public docs, so polling is used instead.

## Confirm queue and Dispatch desk (team workflow)

Two screens under **Orders** in the left menu, built for the team's phones.

**First-time setup**
1. Settings, **Team logins**: create the first **Admin** (the very first admin can be created openly only while no admin exists; create it right after deploying). Then add each person with their **own** login and a temporary password; they choose their own at first sign-in. Never share a login: every action is stamped with the person.
2. Settings, **Confirm queue settings**: what happens after the third unanswered call (auto-cancel or escalate), the date the queue starts from (default: last 7 days), and the **partial payment link** template (for example your Razorpay page, with `{orderId}` and `{amount}` placeholders).
3. Team members open `https://YOUR-SITE/team` on their phone and sign in. Confirmation and packing roles see only their desk (bottom tabs); admins see the whole dashboard.

**Confirm queue.** Pending orders, oldest first, each with a live timer from the order time: green under 2 h, amber 2 to 4 h, red after 4 h (the timer uses the server clock, so a wrong phone clock cannot change the colour). One tap each: **Confirmed**, **Partial pay** (asks how much was paid), **Cancel** (a reason from a fixed list is required), **No answer** (attempt 1, 2, 3 with a 30 minute gap; the third either cancels automatically or escalates, per Settings). Call, WhatsApp and Payment link buttons log themselves; phone numbers are only sent to the browser when one of these is tapped. There is no free-text field anywhere.

**Dispatch desk.** An order enters it when confirmed (or converted to partial pay) in the queue. Three sections, each planned for **24 h after confirmation**:
1. **Print slip**: tap *Slip printed*, then *Scan, weigh and pack*: scan or type the AWB, enter the weight, take a photo of the sealed box on the scale. **No photo, no Packed**: the server refuses without all three, checks the file really is a photo, checks the AWB against Shipway's AWB for that order when Shipway has one, and refuses an AWB already used on another order. Packing moves the order to Ready for pickup.
2. **Ready for pickup**: *Mark dispatched* when the courier collects.
3. **Dispatched**: recent history with an on-time / late marker.

A red **Delayed orders** button appears at the top whenever any confirmed order is past its 24 h plan and not yet dispatched. It lists them oldest first, with a fixed list of delay reasons. Photos are shrunk on the phone before upload (a few hundred KB). Video proof is in the data model but switched off (`FLOW_VIDEO_ENABLED=1` turns on the server side; the app UI for it comes later).

**Log and timeline.** Every action is appended to `FlowEvent` with person, time, previous status, new status and a plain-language line. Nothing edits or deletes these rows. Open any order in **Orders** to see its **Team activity** timeline and **Proof gallery**.

**Overview.** A new **Team performance** block: confirmed within 2 h and 4 h, dispatched within the 24 h plan, share of dispatched orders with a proof photo, open and delayed counts, and a scorecard per person for the confirmation and packing teams.

**Good to know**
- The Google Sheet is still never written to. Decisions made in the queue are laid over the app's own copy of the order (Confirmed, Cancelled, Partial COD) immediately and after every sheet sync, so the Overview numbers move at once. Only orders the sheet still shows as pending are touched. The sheet's own Order Confirmed column will not change by itself.
- Dispatch status from Shipway is unchanged and separate: "Dispatched" in the desk means handed to the courier by your team.
- Photos are stored in MongoDB (survives redeploys on hosts with a temporary disk). Plan on roughly 0.3 to 0.6 MB per order.
- The Vercel proxy in `client/vercel.json` limits request size, which is why photos are compressed in the browser first.
- Camera barcode scanning uses the browser's BarcodeDetector (Chrome on Android). On other browsers, type the AWB or use a USB / Bluetooth scanner, which types into the field.
- Sessions last 12 hours. Switching a person off, or changing their role or password, signs them out at once. Five wrong passwords lock that username and address for 10 minutes. Set `STAFF_TOKEN_SECRET` to pin the signing secret; otherwise one is generated and stored in the database.

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
server/src/lib       clean, metrics, windows, reasons, IST time, flow rules, staff auth (pure, tested)
server/src/services  sheet fetching, sync
server/src/routes    REST API
client/src/pages     Overview, Trends, Payment mode, Reasons, Orders, Confirm queue, Dispatch desk, Data issues, Settings, Team sign-in
```

## Shopify desk (Shopify-only order workflow)

A separate section in the left menu, **Shopify desk**, with tabs. It reads **only Shopify** (the sheet is not involved) and is independent of the older sheet-based Confirm queue / Dispatch desk, which are unchanged.

| Tab | What it shows |
| --- | --- |
| Overview (admin) | Calls due now, confirmed / cancelled rate, where every order is now, orders per day, how FU1 to Day 3 perform, cancel reasons, team activity |
| Shopify orders | Every Shopify order with full details (click for the drawer: customer, address, items, payment, UTM, partial payment + screenshot, cancel reason, full history) and its desk status |
| Confirm queue | New orders start at **FU1**. Cards with a Call button and **Update status** (Confirmed, DNP, Partial paid, Cancelled) |
| Pending orders | Orders with no answer on FU1, FU2 and FU3. Follow-ups **Day 1, Day 2, Day 3** |
| Dispatch queue | Confirmed and partial paid orders, with the amount to collect on delivery. Mark dispatched |
| Partial paid | Amount paid, balance, notes and the payment screenshot |
| Cancelled orders | Full order amount and reason; auto-cancelled orders are marked; admins can restore |
| Settings (admin) | Follow-up timings, cancel reasons, WhatsApp message, screenshot rule, queue start date |

**The flow.** New Shopify order, then FU1. *DNP* asks "WhatsApp message shared? Yes / No" (with an Open WhatsApp button) and moves the order to FU2, then FU3. A DNP on FU3 moves it to **Pending**. In Pending, Day 1, Day 2 and Day 3 follow-ups come due; a DNP on Day 3 **cancels the order automatically** (reason "No response after 6 follow-ups") and it appears in Cancelled orders. *Confirmed* moves the order to Dispatch. *Partial paid* asks for the amount, a screenshot and notes, then moves it to Dispatch with the balance to collect. *Cancelled* asks for a reason. An order cancelled inside Shopify moves to Cancelled by itself.

**Timings (Settings).** FU1 is due N hours after the order was placed (0 = at once). FU2 and FU3 are due N hours after the previous follow-up was marked DNP (default 0 / 2 / 4 h). Pending Day 1/2/3 are counted from the day the order moved to Pending (default 1 / 2 / 3 days). DNP cannot be logged before the follow-up is due.

**Which orders enter.** Only orders placed on or after **Queue starts from** (Settings; defaults to the day the desk was first opened, so old orders do not flood the queue). Move the date back to bring older orders in.

**Live arrival.** The server already pulls Shopify every 2 minutes (and the desk checks for new orders after every pull). For instant arrival, add two webhooks in the Shopify Dev Dashboard, for `orders/create` and `orders/updated`, pointing to `https://YOUR-SERVER/api/webhook/shopify`. They are verified with the app's client secret. **Refresh from Shopify** pulls on demand.

**Who can do what.** Admin: everything. Confirmation team: Confirm queue, Pending, Partial paid and Cancelled tabs and their actions. Packing team: Dispatch queue. Everyone signs in with their own login; every action is stamped with the person and time.

Tests for the rules: `npm test` (`server/test/desk.test.js`). Two older tests (`core`, `shipway`) already failed before this change.
