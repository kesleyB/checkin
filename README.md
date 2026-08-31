# JCF CONCERT 2026 — Offline PWA QR Ticket Scanner

Mobile-first Progressive Web App for checking in e-tickets at a JCF CONCERT. After tickets are synced, **validation and check-in work fully offline** using IndexedDB. Check-ins queue locally and upload to Google Sheets when internet returns.

## Features

- Installable PWA with service worker caching
- IndexedDB ticket store + check-in upload queue
- Camera QR scanning + manual Ticket ID entry
- VALID / ALREADY USED / INVALID result screens
- Google Sheets sync via Apps Script (`Tickets` tab only)
- Multi-volunteer support with server-side duplicate prevention
- CSV/JSON export backup

## Architecture

```text
Google Sheets (Tickets tab)
        ↕ Apps Script Web App
PWA IndexedDB (tickets + checkInQueue)
        ↕ QR Scanner (offline)
```

Scanning never requires network. The sheet is authoritative once check-ins sync.

## Quick start

### Local development

```bash
python -m http.server 8080
```

Open `http://localhost:8080` on your phone or desktop.

### Deploy Apps Script backend

1. Open your Google Spreadsheet with the `Tickets` tab.
2. **Extensions → Apps Script** — paste [`backend/apps-script/Code.gs`](backend/apps-script/Code.gs).
3. Deploy as **Web app** (Execute as Me, Anyone with link).
4. See [`backend/apps-script/README.md`](backend/apps-script/README.md) for API details.

### Configure each volunteer phone

1. Open the PWA → **Admin**
2. Set **Device ID** (e.g. `VOLUNTEER-01`, `VOLUNTEER-02`)
3. Paste **Apps Script Web App URL**
4. Tap **Sync now** → confirm ticket count
5. Add to home screen; disable data for event if desired

## Event-day workflow

```text
1. ONLINE — Admin → Sync now (download tickets)
2. Confirm dashboard counts
3. Test scan
4. OFFLINE — scan works from IndexedDB
5. Check-ins queue locally (Pending upload count)
6. When online — auto or manual Sync now uploads to Sheets
7. Export CSV backup after event if needed
```

## Ticket data (Tickets tab only)

The PWA syncs these fields — never `Orders`, payment screenshots, or email URLs:

| Field | Sheet column |
|-------|----------------|
| ticketId | A — Ticket ID |
| orderId | B — Order ID |
| buyerName | C — Buyer Name |
| ticketType | D — Ticket Type |
| status | E — Status |
| qrData | F — QR Data |
| checkedInAt | H — Checked In At |

QR codes contain only the Ticket ID / QR Data text (e.g. `CHC-9S6PBBUMCA`).

## Sync behavior

### Download (`GET ?action=tickets`)

- Merges server tickets into local IndexedDB
- Server `USED` always overwrites local
- Local `USED` with pending upload kept until uploaded

### Upload (`POST action=checkin`)

- Each local check-in queued with `syncStatus: PENDING`
- Upload runs on: Sync now, app startup (if online), reconnect, after check-in (background)
- Server rejects duplicate with `ALREADY_USED` — local ticket updated from sheet

### Multi-device caveat

Two phones offline may both show VALID for the same ticket. The **Google Sheet decides** when uploads sync — first upload wins.

## File import (backup)

Admin → Import file still works (JSON/CSV full replace). Use when Apps Script is unavailable.

Sample: [`sample-tickets.json`](sample-tickets.json)

## Project files

```text
index.html              App shell
app.js                  Scanner UI + sync triggers
db.js                   IndexedDB (tickets + queue)
sync.js                 Apps Script download/upload
service-worker.js       Offline cache
backend/apps-script/    Google Sheets API (deploy separately)
```

## Testing

| Test | Expected |
|------|----------|
| Sync now downloads tickets | Dashboard shows counts |
| Offline scan VALID | Local USED + pending upload +1 |
| Sync uploads check-in | Sheet Status=USED, queue cleared |
| Scan same ticket again | ALREADY USED with checked-in time |
| Two devices offline same ticket | Both VALID locally; first sync wins on sheet |
| Airplane mode upload | Fails gracefully; retries when online |

## Privacy

Local storage: Ticket ID, order ID, buyer name, ticket type, status, check-in time. No payment or contact data beyond buyer name.
