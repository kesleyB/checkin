# Google Apps Script Backend

API layer for the JCF CONCERT PWA. Reads/writes the **`Tickets`** tab only — never `Orders`.

## Setup

1. Open your Google Spreadsheet.
2. **Extensions → Apps Script**
3. Replace `Code.gs` contents with [`Code.gs`](Code.gs) from this folder.
4. Confirm the `Tickets` tab has columns A–H:
   - A: Ticket ID
   - B: Order ID
   - C: Buyer Name
   - D: Ticket Type
   - E: Status (`UNUSED` / `USED`)
   - F: QR Data
   - H: Checked In At
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the Web App URL into the PWA Admin screen.

## API

### Download tickets

```http
GET {WEB_APP_URL}?action=tickets
```

### Upload check-in

```http
POST {WEB_APP_URL}
Content-Type: application/json

{
  "action": "checkin",
  "ticketId": "CHC-9S6PBBUMCA",
  "checkedInAt": "2026-08-31T18:42:15+08:00",
  "deviceId": "VOLUNTEER-01"
}
```

## Security

- The spreadsheet itself stays private; only the Web App URL is shared with volunteers.
- The API returns only scanner fields — no payment screenshots, email URLs, or QR images.

## Multi-device

Check-in uses `LockService` so concurrent uploads serialize. The sheet row is authoritative: first successful check-in wins; later uploads get `ALREADY_USED`.
