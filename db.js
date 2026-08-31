/**
 * IndexedDB ticket store for JCF CONCERT check-in.
 * All validation and check-in persistence happens here — no network during scan.
 */

const DB_NAME = "church-concert-checkin";
const DB_VERSION = 2;
const STORE_TICKETS = "tickets";
const STORE_QUEUE = "checkInQueue";

const META_LAST_SYNC = "cc_lastSyncAt";
const META_LAST_UPLOAD = "cc_lastUploadAt";
const META_SYNC_URL = "cc_syncUrl";
const META_DEVICE_ID = "cc_deviceId";
const ALLOWED_TYPES = new Set(["General Admission", "Sponsor"]);
const ALLOWED_STATUS = new Set(["UNUSED", "USED"]);
const QUEUE_PENDING = "PENDING";
const QUEUE_SYNCED = "SYNCED";
const QUEUE_FAILED = "FAILED";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      dbPromise = null;
      reject(new Error("Could not open the ticket database. Try refreshing the app."));
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      if (!db.objectStoreNames.contains(STORE_TICKETS)) {
        db.createObjectStore(STORE_TICKETS, { keyPath: "ticketId" });
      }

      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const queue = db.createObjectStore(STORE_QUEUE, {
          keyPath: "id",
          autoIncrement: true,
        });
        queue.createIndex("syncStatus", "syncStatus", { unique: false });
        queue.createIndex("ticketId", "ticketId", { unique: false });
      }

      // v1 → v2: queue store added; tickets keep existing rows
      if (oldVersion > 0 && oldVersion < 2) {
        /* existing tickets preserved */
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
  });

  return dbPromise;
}

function txStores(storeNames, mode) {
  return openDb().then((db) => {
    const tx = db.transaction(storeNames, mode);
    const stores = {};
    storeNames.forEach((name) => {
      stores[name] = tx.objectStore(name);
    });
    return { tx, stores };
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Database operation failed."));
  });
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Database transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("Database transaction aborted."));
  });
}

function normalizeTicketId(raw) {
  if (raw == null) return "";
  return String(raw).trim().toUpperCase();
}

function getLastSyncAt() {
  return localStorage.getItem(META_LAST_SYNC);
}

function setLastSyncAt(iso) {
  localStorage.setItem(META_LAST_SYNC, iso);
}

function getLastUploadAt() {
  return localStorage.getItem(META_LAST_UPLOAD);
}

function setLastUploadAt(iso) {
  localStorage.setItem(META_LAST_UPLOAD, iso);
}

function getSyncUrl() {
  return localStorage.getItem(META_SYNC_URL) || "";
}

function setSyncUrl(url) {
  if (url) localStorage.setItem(META_SYNC_URL, url);
  else localStorage.removeItem(META_SYNC_URL);
}

function getDeviceId() {
  return localStorage.getItem(META_DEVICE_ID) || "VOLUNTEER-01";
}

function setDeviceId(id) {
  const v = String(id || "").trim() || "VOLUNTEER-01";
  localStorage.setItem(META_DEVICE_ID, v);
}

function validateTicketRow(row, index) {
  const label = `Row ${index + 1}`;

  if (!row || typeof row !== "object") {
    return { ok: false, error: `${label}: not a valid ticket object.` };
  }

  const ticketId = normalizeTicketId(
    row.ticketId ?? row.ticket_id ?? row["Ticket ID"] ?? row.TicketID
  );
  if (!ticketId) {
    return { ok: false, error: `${label}: missing Ticket ID.` };
  }
  if (/\s/.test(ticketId)) {
    return { ok: false, error: `${label}: Ticket ID cannot contain spaces (${ticketId}).` };
  }

  const buyerName = String(
    row.buyerName ?? row.buyer_name ?? row["Buyer Name"] ?? row.BuyerName ?? ""
  ).trim();
  if (!buyerName) {
    return { ok: false, error: `${label} (${ticketId}): missing buyer name.` };
  }

  let ticketType = String(
    row.ticketType ?? row.ticket_type ?? row["Ticket Type"] ?? row.TicketType ?? ""
  ).trim();
  if (/^ga$|^general$/i.test(ticketType)) ticketType = "General Admission";
  if (/^sponsor$/i.test(ticketType)) ticketType = "Sponsor";
  if (!ALLOWED_TYPES.has(ticketType)) {
    return {
      ok: false,
      error: `${label} (${ticketId}): ticket type must be "General Admission" or "Sponsor".`,
    };
  }

  let status = String(row.status ?? row.Status ?? "UNUSED").trim().toUpperCase();
  if (["VERIFIED", "VALID", "PAID", "CONFIRMED", "ACTIVE"].includes(status)) {
    status = "UNUSED";
  }
  if (!ALLOWED_STATUS.has(status)) {
    return {
      ok: false,
      error: `${label} (${ticketId}): status must be UNUSED or USED (got "${row.status}").`,
    };
  }

  let checkedInAt =
    row.checkedInAt ?? row.checked_in_at ?? row["Checked In At"] ?? null;
  if (status === "UNUSED") {
    checkedInAt = null;
  } else if (checkedInAt) {
    checkedInAt = String(checkedInAt);
  } else {
    checkedInAt = null;
  }

  const orderId = String(row.orderId ?? row.order_id ?? row["Order ID"] ?? "").trim() || null;
  let qrData = normalizeTicketId(row.qrData ?? row.qr_data ?? row["QR Data"] ?? "");
  if (!qrData) qrData = ticketId;

  return {
    ok: true,
    ticket: {
      ticketId,
      orderId,
      buyerName,
      ticketType,
      status,
      qrData,
      checkedInAt,
    },
  };
}

function validateImportRows(rows) {
  if (!Array.isArray(rows)) {
    return { tickets: [], errors: ["Import data must be a JSON array of tickets."] };
  }
  if (rows.length === 0) {
    return { tickets: [], errors: ["Import file contains no tickets."] };
  }

  const errors = [];
  const seen = new Map();
  const tickets = [];

  rows.forEach((row, index) => {
    const result = validateTicketRow(row, index);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    const id = result.ticket.ticketId;
    if (seen.has(id)) {
      errors.push(
        `Duplicate Ticket ID "${id}" found at rows ${seen.get(id) + 1} and ${index + 1}.`
      );
      return;
    }
    seen.set(id, index);
    tickets.push(result.ticket);
  });

  return { tickets, errors };
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one ticket row.");
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] != null ? cols[idx].trim() : "";
    });
    rows.push(obj);
  }

  return rows;
}

function splitCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function importTickets(tickets) {
  const { tx, stores } = await txStores([STORE_TICKETS], "readwrite");
  stores[STORE_TICKETS].clear();
  for (const ticket of tickets) {
    stores[STORE_TICKETS].put(ticket);
  }
  await txComplete(tx);
  setLastSyncAt(new Date().toISOString());
  return tickets.length;
}

/** Ticket IDs with PENDING or FAILED queue items. */
async function getPendingQueueTicketIds() {
  const items = await getPendingCheckIns();
  return new Set(items.map((q) => q.ticketId));
}

/**
 * Merge server tickets into local DB (full sync inventory).
 * Sheet USED always wins; local USED with pending upload is kept until synced.
 */
async function mergeTicketsFromServer(serverTickets) {
  const { tickets, errors } = validateImportRows(serverTickets);
  if (errors.length) {
    const preview = errors.slice(0, 3).join(" ");
    throw new Error(`Server ticket data invalid: ${preview}`);
  }

  const pendingIds = await getPendingQueueTicketIds();
  const serverIds = new Set(tickets.map((t) => t.ticketId));

  const { tx, stores } = await txStores([STORE_TICKETS], "readwrite");
  const ticketStore = stores[STORE_TICKETS];

  const localAll = await requestToPromise(ticketStore.getAll());
  const localMap = new Map(localAll.map((t) => [t.ticketId, t]));

  for (const serverTicket of tickets) {
    const local = localMap.get(serverTicket.ticketId);

    if (serverTicket.status === "USED") {
      ticketStore.put(serverTicket);
      continue;
    }

    if (
      local &&
      local.status === "USED" &&
      pendingIds.has(serverTicket.ticketId)
    ) {
      ticketStore.put({
        ...serverTicket,
        status: "USED",
        checkedInAt: local.checkedInAt || serverTicket.checkedInAt,
      });
      continue;
    }

    ticketStore.put(serverTicket);
  }

  for (const local of localAll) {
    if (!serverIds.has(local.ticketId)) {
      ticketStore.delete(local.ticketId);
    }
  }

  await txComplete(tx);
  setLastSyncAt(new Date().toISOString());
  return tickets.length;
}

async function findTicketByQrOrId(rawId) {
  const normalized = normalizeTicketId(rawId);
  if (!normalized) return null;

  const all = await getAllTickets();
  for (const t of all) {
    if (t.ticketId === normalized) return t;
    if (normalizeTicketId(t.qrData) === normalized) return t;
  }
  return null;
}

async function getTicket(ticketId) {
  const id = normalizeTicketId(ticketId);
  if (!id) return null;
  const { stores } = await txStores([STORE_TICKETS], "readonly");
  return requestToPromise(stores[STORE_TICKETS].get(id));
}

async function getAllTickets() {
  const { stores } = await txStores([STORE_TICKETS], "readonly");
  return requestToPromise(stores[STORE_TICKETS].getAll());
}

async function enqueueCheckIn(ticketId, checkedInAt, deviceId) {
  const { tx, stores } = await txStores([STORE_QUEUE], "readwrite");
  stores[STORE_QUEUE].add({
    ticketId,
    checkedInAt,
    deviceId: deviceId || getDeviceId(),
    syncStatus: QUEUE_PENDING,
    lastError: null,
    createdAt: new Date().toISOString(),
  });
  await txComplete(tx);
}

/**
 * Check in a ticket if UNUSED.
 * Persists USED + checkedInAt + queue entry BEFORE resolving success.
 */
async function checkInTicket(rawId) {
  const lookupKey = normalizeTicketId(rawId);
  if (!lookupKey) {
    return { outcome: "EMPTY" };
  }

  const existing = await findTicketByQrOrId(rawId);
  if (!existing) {
    return { outcome: "INVALID" };
  }

  if (existing.status === "USED") {
    return { outcome: "USED", ticket: existing };
  }

  const checkedInAt = new Date().toISOString();
  const updated = {
    ...existing,
    status: "USED",
    checkedInAt,
  };

  const { tx, stores } = await txStores([STORE_TICKETS, STORE_QUEUE], "readwrite");
  stores[STORE_TICKETS].put(updated);
  stores[STORE_QUEUE].add({
    ticketId: existing.ticketId,
    checkedInAt,
    deviceId: getDeviceId(),
    syncStatus: QUEUE_PENDING,
    lastError: null,
    createdAt: checkedInAt,
  });
  await txComplete(tx);

  return { outcome: "VALID", ticket: updated };
}

async function getPendingCheckIns() {
  const { stores } = await txStores([STORE_QUEUE], "readonly");
  const all = await requestToPromise(stores[STORE_QUEUE].getAll());
  return all
    .filter((q) => q.syncStatus === QUEUE_PENDING || q.syncStatus === QUEUE_FAILED)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

async function markQueueSynced(id) {
  const { tx, stores } = await txStores([STORE_QUEUE], "readwrite");
  const item = await requestToPromise(stores[STORE_QUEUE].get(id));
  if (item) {
    stores[STORE_QUEUE].put({ ...item, syncStatus: QUEUE_SYNCED, lastError: null });
  }
  await txComplete(tx);
  setLastUploadAt(new Date().toISOString());
}

async function markQueueFailed(id, error) {
  const { tx, stores } = await txStores([STORE_QUEUE], "readwrite");
  const item = await requestToPromise(stores[STORE_QUEUE].get(id));
  if (item) {
    stores[STORE_QUEUE].put({
      ...item,
      syncStatus: QUEUE_FAILED,
      lastError: String(error || "Upload failed"),
    });
  }
  await txComplete(tx);
}

async function applyServerCheckInConflict(ticketId, checkedInAt) {
  const id = normalizeTicketId(ticketId);
  const { tx, stores } = await txStores([STORE_TICKETS], "readwrite");
  const existing = await requestToPromise(stores[STORE_TICKETS].get(id));
  if (existing) {
    stores[STORE_TICKETS].put({
      ...existing,
      status: "USED",
      checkedInAt: checkedInAt || existing.checkedInAt,
    });
  }
  await txComplete(tx);
}

async function getStats() {
  const tickets = await getAllTickets();
  const total = tickets.length;
  let checkedIn = 0;
  let general = 0;
  let sponsor = 0;

  for (const t of tickets) {
    if (t.status === "USED") checkedIn++;
    if (t.ticketType === "General Admission") general++;
    if (t.ticketType === "Sponsor") sponsor++;
  }

  const syncStats = await getSyncStats();

  return {
    total,
    checkedIn,
    remaining: total - checkedIn,
    general,
    sponsor,
    lastSyncAt: getLastSyncAt(),
    pendingUploads: syncStats.pendingUploads,
    lastUploadAt: syncStats.lastUploadAt,
  };
}

async function getSyncStats() {
  const pending = await getPendingCheckIns();
  return {
    pendingUploads: pending.length,
    lastSyncAt: getLastSyncAt(),
    lastUploadAt: getLastUploadAt(),
  };
}

async function clearAllTickets() {
  const { tx, stores } = await txStores([STORE_TICKETS, STORE_QUEUE], "readwrite");
  stores[STORE_TICKETS].clear();
  stores[STORE_QUEUE].clear();
  await txComplete(tx);
  localStorage.removeItem(META_LAST_SYNC);
  localStorage.removeItem(META_LAST_UPLOAD);
}

function ticketsToCsv(tickets) {
  const header = "ticketId,orderId,buyerName,ticketType,status,qrData,checkedInAt";
  const lines = tickets.map((t) =>
    [
      csvEscape(t.ticketId),
      csvEscape(t.orderId || ""),
      csvEscape(t.buyerName),
      csvEscape(t.ticketType),
      csvEscape(t.status),
      csvEscape(t.qrData || t.ticketId),
      csvEscape(t.checkedInAt || ""),
    ].join(",")
  );
  return [header, ...lines].join("\n");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCsv(checkedInOnly = false) {
  let tickets = await getAllTickets();
  if (checkedInOnly) {
    tickets = tickets.filter((t) => t.status === "USED");
  }
  tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId));
  const csv = ticketsToCsv(tickets);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = checkedInOnly
    ? `checkins-${stamp}.csv`
    : `tickets-backup-${stamp}.csv`;
  downloadBlob(name, csv, "text/csv;charset=utf-8");
  return tickets.length;
}

async function exportJson(checkedInOnly = false) {
  let tickets = await getAllTickets();
  if (checkedInOnly) {
    tickets = tickets.filter((t) => t.status === "USED");
  }
  tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = checkedInOnly
    ? `checkins-${stamp}.json`
    : `tickets-backup-${stamp}.json`;
  downloadBlob(name, JSON.stringify(tickets, null, 2), "application/json");
  return tickets.length;
}

window.TicketDB = {
  openDb,
  normalizeTicketId,
  validateImportRows,
  parseCsv,
  importTickets,
  mergeTicketsFromServer,
  getTicket,
  findTicketByQrOrId,
  getAllTickets,
  checkInTicket,
  getStats,
  getSyncStats,
  getPendingCheckIns,
  markQueueSynced,
  markQueueFailed,
  applyServerCheckInConflict,
  clearAllTickets,
  exportCsv,
  exportJson,
  getLastSyncAt,
  getLastUploadAt,
  getSyncUrl,
  setSyncUrl,
  getDeviceId,
  setDeviceId,
};
