/**
 * Google Sheets sync orchestration for JCF CONCERT check-in PWA.
 * Scan/check-in never calls this module — only Admin, startup, and online events.
 */

const TicketSync = (() => {
  "use strict";

  let syncing = false;
  let retryTimer = null;

  function buildUrl(base, params) {
    const url = new URL(base);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") url.searchParams.set(k, v);
    });
    return url.toString();
  }

  async function downloadTickets() {
    const baseUrl = TicketDB.getSyncUrl();
    if (!baseUrl) {
      throw new Error("Set the Apps Script Web App URL in Admin first.");
    }

    const url = buildUrl(baseUrl, { action: "tickets" });

    const res = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Download failed (HTTP ${res.status}).`);
    }

    const data = await res.json();
    if (data.ok === false) {
      throw new Error(data.error || "Download failed.");
    }

    let rows;
    if (Array.isArray(data)) {
      rows = data;
    } else if (Array.isArray(data.tickets)) {
      rows = data.tickets;
    } else {
      throw new Error("Server response missing tickets array.");
    }

    const count = await TicketDB.mergeTicketsFromServer(rows);
    return { downloaded: count, syncedAt: data.syncedAt || new Date().toISOString() };
  }

  async function uploadOneCheckIn(item) {
    const baseUrl = TicketDB.getSyncUrl();
    const body = {
      action: "checkin",
      ticketId: item.ticketId,
      checkedInAt: item.checkedInAt,
      deviceId: item.deviceId || TicketDB.getDeviceId(),
    };
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Upload failed (HTTP ${res.status}). Invalid response.`);
    }

    if (!res.ok && !data.code) {
      throw new Error(data.error || `Upload failed (HTTP ${res.status}).`);
    }

    if (data.ok === true) {
      await TicketDB.markQueueSynced(item.id);
      return { status: "SUCCESS", ticketId: item.ticketId };
    }

    if (data.code === "ALREADY_USED") {
      await TicketDB.applyServerCheckInConflict(
        data.ticketId || item.ticketId,
        data.checkedInAt
      );
      await TicketDB.markQueueSynced(item.id);
      return { status: "ALREADY_USED", ticketId: item.ticketId };
    }

    if (data.code === "NOT_FOUND") {
      await TicketDB.markQueueFailed(item.id, data.error || "Ticket not found on server.");
      return { status: "FAILED", ticketId: item.ticketId, error: data.error };
    }

    throw new Error(data.error || "Upload failed.");
  }

  async function uploadPendingCheckIns() {
    const pending = await TicketDB.getPendingCheckIns();
    let uploaded = 0;
    let failed = 0;
    let conflicts = 0;

    for (const item of pending) {
      try {
        const result = await uploadOneCheckIn(item);
        if (result.status === "SUCCESS") uploaded++;
        else if (result.status === "ALREADY_USED") conflicts++;
        else failed++;
      } catch (err) {
        await TicketDB.markQueueFailed(item.id, err.message || "Network error");
        failed++;
      }
    }

    return { uploaded, failed, conflicts, total: pending.length };
  }

  async function runFullSync() {
    if (syncing) {
      return { skipped: true, message: "Sync already in progress." };
    }
    if (!navigator.onLine) {
      throw new Error("You are offline. Connect to the internet to sync.");
    }
    if (!TicketDB.getSyncUrl()) {
      throw new Error("Set the Apps Script Web App URL in Admin first.");
    }

    syncing = true;
    try {
      const upload = await uploadPendingCheckIns();
      const download = await downloadTickets();
      return {
        uploaded: upload.uploaded,
        uploadFailed: upload.failed,
        conflicts: upload.conflicts,
        downloaded: download.downloaded,
        syncedAt: download.syncedAt,
      };
    } finally {
      syncing = false;
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(async () => {
      if (!navigator.onLine || !TicketDB.getSyncUrl()) return;
      const { pendingUploads } = await TicketDB.getSyncStats();
      if (pendingUploads === 0) {
        clearInterval(retryTimer);
        retryTimer = null;
        return;
      }
      try {
        await runFullSync();
        if (typeof window.onSyncComplete === "function") {
          window.onSyncComplete();
        }
      } catch (err) {
        console.warn("Background sync failed:", err);
      }
    }, 30000);
  }

  async function onOnline() {
    if (!navigator.onLine || !TicketDB.getSyncUrl()) return null;
    try {
      const result = await runFullSync();
      scheduleRetry();
      return result;
    } catch (err) {
      console.warn("Auto sync on online failed:", err);
      scheduleRetry();
      return null;
    }
  }

  async function afterLocalCheckIn() {
    if (!navigator.onLine || !TicketDB.getSyncUrl()) {
      scheduleRetry();
      return null;
    }
    try {
      const upload = await uploadPendingCheckIns();
      if (upload.uploaded > 0 || upload.conflicts > 0) {
        await downloadTickets();
      }
      scheduleRetry();
      return upload;
    } catch (err) {
      console.warn("Post check-in sync failed:", err);
      scheduleRetry();
      return null;
    }
  }

  return {
    downloadTickets,
    uploadPendingCheckIns,
    runFullSync,
    onOnline,
    afterLocalCheckIn,
    isSyncing: () => syncing,
  };
})();

window.TicketSync = TicketSync;
