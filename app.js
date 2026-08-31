/**
 * JCF CONCERT Check-In — UI, scanner, admin, offline status.
 * Ticket validation is local-only via TicketDB (IndexedDB).
 */

(() => {
  "use strict";

  const views = {
    dashboard: document.getElementById("view-dashboard"),
    scanner: document.getElementById("view-scanner"),
    result: document.getElementById("view-result"),
    manual: document.getElementById("view-manual"),
    admin: document.getElementById("view-admin"),
  };

  let currentView = "dashboard";
  let html5QrCode = null;
  let scanning = false;
  let processingScan = false;
  let hasTicketsLoaded = false;
  let pendingUploads = 0;

  // ——— Views ———

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      const active = key === name;
      el.classList.toggle("view-active", active);
      if (active) {
        el.removeAttribute("hidden");
      } else {
        el.setAttribute("hidden", "");
      }
    });
    currentView = name;
  }

  // ——— Network status ———

  function updateNetworkStatus() {
    const pill = document.getElementById("status-pill");
    const text = document.getElementById("status-text");
    const online = navigator.onLine;

    pill.classList.remove(
      "status-online",
      "status-offline-ready",
      "status-offline-works",
      "status-offline-empty",
      "status-pending-sync"
    );

    if (online) {
      if (pendingUploads > 0) {
        pill.classList.add("status-pending-sync");
        text.textContent = `ONLINE — ${pendingUploads} CHECK-INS TO SYNC`;
      } else if (hasTicketsLoaded) {
        pill.classList.add("status-offline-ready");
        text.textContent = "OFFLINE READY";
      } else {
        pill.classList.add("status-online");
        text.textContent = "ONLINE";
      }
    } else if (hasTicketsLoaded) {
      pill.classList.add("status-offline-works");
      text.textContent = "OFFLINE — CHECK-IN WORKS";
    } else {
      pill.classList.add("status-offline-empty");
      text.textContent = "OFFLINE — NO TICKETS";
    }
  }

  // ——— Dashboard stats ———

  function formatSyncDate(iso) {
    if (!iso) return "Never";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        dateStyle: "long",
        timeStyle: "short",
      });
    } catch {
      return iso;
    }
  }

  async function refreshDashboard() {
    try {
      await TicketDB.openDb();
      const stats = await TicketDB.getStats();
      hasTicketsLoaded = stats.total > 0;

      document.getElementById("stat-checked-in").textContent = String(stats.checkedIn);
      document.getElementById("stat-remaining").textContent = String(stats.remaining);
      document.getElementById("stat-total").textContent = String(stats.total);
      document.getElementById("stat-general").textContent = String(stats.general);
      document.getElementById("stat-sponsor").textContent = String(stats.sponsor);
      document.getElementById("stat-pending").textContent = String(stats.pendingUploads || 0);
      pendingUploads = stats.pendingUploads || 0;
      document.getElementById("last-sync-text").textContent = formatSyncDate(
        stats.lastSyncAt
      );

      document
        .getElementById("no-tickets-banner")
        .classList.toggle("hidden", hasTicketsLoaded);

      document.getElementById("btn-scan").disabled = !hasTicketsLoaded;
      updateNetworkStatus();
    } catch (err) {
      console.error(err);
      document.getElementById("no-tickets-banner").textContent =
        "Database unavailable. Try refreshing the app.";
      document.getElementById("no-tickets-banner").classList.remove("hidden");
      document.getElementById("btn-scan").disabled = true;
    }
  }

  // ——— Feedback (vibrate / beep) ———

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }

  function beep(success) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = success ? 880 : 220;
      gain.gain.value = 0.12;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.stop(ctx.currentTime + 0.22);
      setTimeout(() => ctx.close(), 300);
    } catch {
      /* ignore */
    }
  }

  // ——— Check-in / results ———

  async function processTicketId(rawId) {
    if (processingScan) return;
    processingScan = true;

    try {
      const result = await TicketDB.checkInTicket(rawId);
      await showResult(result);
      if (result.outcome === "VALID") {
        TicketSync.afterLocalCheckIn().then(() => refreshDashboard()).catch(() => {});
      }
    } catch (err) {
      console.error(err);
      await showResult({
        outcome: "INVALID",
        errorMessage: "Something went wrong reading the ticket database.",
      });
    } finally {
      processingScan = false;
    }
  }

  async function showResult(result) {
    await stopScanner();

    const panel = document.getElementById("result-panel");
    const icon = document.getElementById("result-icon");
    const title = document.getElementById("result-title");
    const action = document.getElementById("result-action");
    const nameEl = document.getElementById("result-name");
    const typeEl = document.getElementById("result-type");
    const idEl = document.getElementById("result-id");
    const msg = document.getElementById("result-message");
    const details = document.getElementById("result-details");

    panel.classList.remove("result-valid", "result-used", "result-invalid");

    if (result.outcome === "VALID") {
      panel.classList.add("result-valid");
      icon.textContent = "✓";
      title.textContent = "VALID TICKET";
      action.textContent = "ADMIT THIS PERSON";
      details.classList.remove("hidden");
      nameEl.textContent = result.ticket.buyerName;
      typeEl.textContent = result.ticket.ticketType;
      idEl.textContent = result.ticket.ticketId;
      msg.textContent = "CHECK-IN SUCCESSFUL";
      vibrate([40, 40, 80]);
      beep(true);
    } else if (result.outcome === "USED") {
      panel.classList.add("result-used");
      icon.textContent = "✕";
      title.textContent = "ALREADY USED";
      action.textContent = "DO NOT ADMIT";
      details.classList.remove("hidden");
      nameEl.textContent = result.ticket.buyerName;
      typeEl.textContent = result.ticket.ticketType;
      idEl.textContent = result.ticket.ticketId;
      const checkedLabel = result.ticket.checkedInAt
        ? `Checked in: ${formatSyncDate(result.ticket.checkedInAt)}`
        : "This ticket has already been checked in.";
      msg.textContent = checkedLabel;
      vibrate([120, 60, 120]);
      beep(false);
    } else {
      panel.classList.add("result-invalid");
      icon.textContent = "✕";
      title.textContent = "INVALID TICKET";
      action.textContent = "DO NOT ADMIT";
      details.classList.add("hidden");
      nameEl.textContent = "";
      typeEl.textContent = "";
      idEl.textContent = "";
      msg.textContent =
        result.errorMessage ||
        (result.outcome === "EMPTY"
          ? "Empty or unreadable Ticket ID."
          : "This ticket was not found in the event database.");
      vibrate([200]);
      beep(false);
    }

    showView("result");
    await refreshDashboard();
  }

  // ——— QR Scanner ———

  async function startScanner() {
    const cameraError = document.getElementById("camera-error");
    cameraError.classList.add("hidden");
    cameraError.textContent = "";

    showView("scanner");

    if (typeof Html5Qrcode === "undefined") {
      cameraError.textContent =
        "Camera scanner library is unavailable. Use manual Ticket ID entry below.";
      cameraError.classList.remove("hidden");
      return;
    }

    try {
      if (!html5QrCode) {
        html5QrCode = new Html5Qrcode("reader", { verbose: false });
      }

      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) {
        throw new Error("No camera found on this device.");
      }

      // Prefer back camera when labels are available
      let cameraId = cameras[0].id;
      const back = cameras.find((c) => /back|rear|environment/i.test(c.label || ""));
      if (back) cameraId = back.id;

      scanning = true;
      await html5QrCode.start(
        cameraId,
        {
          fps: 8,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const edge = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.floor(edge * 0.72);
            return { width: size, height: size };
          },
          aspectRatio: 1,
        },
        async (decodedText) => {
          if (!scanning || processingScan) return;
          scanning = false;
          try {
            await html5QrCode.pause(true);
          } catch {
            /* continue */
          }
          await processTicketId(decodedText);
        },
        () => {
          /* ignore frame errors */
        }
      );
    } catch (err) {
      console.warn("Camera start failed:", err);
      const message =
        err && err.name === "NotAllowedError"
          ? "Camera permission was denied. You can still enter a Ticket ID manually below."
          : "Camera is unavailable. You can enter a Ticket ID manually below.";
      cameraError.textContent = message;
      cameraError.classList.remove("hidden");
      scanning = false;
    }
  }

  async function stopScanner() {
    scanning = false;
    if (!html5QrCode) return;
    try {
      const state = html5QrCode.getState && html5QrCode.getState();
      // 2 = SCANNING, 3 = PAUSED (html5-qrcode Html5QrcodeScannerState)
      if (state === 2 || state === 3) {
        await html5QrCode.stop();
        await html5QrCode.clear();
      }
    } catch (err) {
      console.warn("stopScanner:", err);
      try {
        await html5QrCode.clear();
      } catch {
        /* ignore */
      }
    }
  }

  // ——— Import helpers ———

  async function applyImportRows(rows) {
    const { tickets, errors } = TicketDB.validateImportRows(rows);
    if (errors.length) {
      const preview = errors.slice(0, 5).join(" ");
      const more = errors.length > 5 ? ` (+${errors.length - 5} more)` : "";
      throw new Error(`Import rejected: ${preview}${more}`);
    }
    const count = await TicketDB.importTickets(tickets);
    return count;
  }

  async function importFromFile(file) {
    const text = await file.text();
    const name = (file.name || "").toLowerCase();
    let rows;

    if (name.endsWith(".csv") || file.type === "text/csv") {
      rows = TicketDB.parseCsv(text);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON file.");
      }
      if (Array.isArray(parsed)) {
        rows = parsed;
      } else if (parsed && Array.isArray(parsed.tickets)) {
        rows = parsed.tickets;
      } else {
        throw new Error("JSON must be an array of tickets or { \"tickets\": [...] }.");
      }
    }

    return applyImportRows(rows);
  }

  async function importFromUrl(url) {
    TicketDB.setSyncUrl(url);
    const result = await TicketSync.downloadTickets();
    return result.downloaded;
  }

  function saveAdminSettings() {
    TicketDB.setSyncUrl(document.getElementById("sync-url").value.trim());
    TicketDB.setDeviceId(document.getElementById("device-id").value.trim());
  }

  function loadAdminSettings() {
    document.getElementById("sync-url").value = TicketDB.getSyncUrl();
    document.getElementById("device-id").value = TicketDB.getDeviceId();
  }

  function formatSyncResult(result) {
    if (result.skipped) return result.message;
    const parts = [];
    if (result.downloaded != null) parts.push(`Downloaded ${result.downloaded} tickets`);
    if (result.uploaded != null) parts.push(`Uploaded ${result.uploaded} check-ins`);
    if (result.conflicts) parts.push(`${result.conflicts} already used on server`);
    if (result.uploadFailed) parts.push(`${result.uploadFailed} failed`);
    return parts.join(" · ") || "Sync complete.";
  }

  // ——— Navigation guards ———

  async function leaveScannerTo(viewName) {
    if (currentView === "scanner" && scanning) {
      const ok = confirm("Leave scanner? Camera will close.");
      if (!ok) return;
    }
    await stopScanner();
    showView(viewName);
    if (viewName === "dashboard") await refreshDashboard();
  }

  // ——— Event bindings ———

  function bindEvents() {
    document.getElementById("btn-scan").addEventListener("click", () => {
      if (!hasTicketsLoaded) return;
      startScanner();
    });

    document.getElementById("btn-scanner-back").addEventListener("click", () => {
      leaveScannerTo("dashboard");
    });

    document.getElementById("btn-scan-next").addEventListener("click", () => {
      document.getElementById("manual-id-scan").value = "";
      startScanner();
    });

    document.getElementById("btn-manual").addEventListener("click", () => {
      document.getElementById("manual-id").value = "";
      document.getElementById("manual-lookup").classList.add("hidden");
      showView("manual");
      document.getElementById("manual-id").focus();
    });

    document.getElementById("btn-manual-back").addEventListener("click", () => {
      showView("dashboard");
    });

    document.getElementById("btn-manual-submit").addEventListener("click", () => {
      const id = document.getElementById("manual-id").value;
      processTicketId(id);
    });

    document.getElementById("manual-id").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        processTicketId(document.getElementById("manual-id").value);
      }
    });

    document.getElementById("btn-manual-submit-scan").addEventListener("click", () => {
      const id = document.getElementById("manual-id-scan").value;
      processTicketId(id);
    });

    document.getElementById("manual-id-scan").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        processTicketId(document.getElementById("manual-id-scan").value);
      }
    });

    document.getElementById("btn-admin").addEventListener("click", () => {
      loadAdminSettings();
      document.getElementById("import-result").textContent = "";
      document.getElementById("sync-result").textContent = "";
      document.getElementById("export-result").textContent = "";
      showView("admin");
    });

    document.getElementById("btn-admin-back").addEventListener("click", async () => {
      showView("dashboard");
      await refreshDashboard();
    });

    document.getElementById("btn-import-file").addEventListener("click", async () => {
      const input = document.getElementById("import-file");
      const msg = document.getElementById("import-result");
      msg.className = "admin-msg";
      if (!input.files || !input.files[0]) {
        msg.textContent = "Choose a JSON or CSV file first.";
        msg.classList.add("err");
        return;
      }
      try {
        const count = await importFromFile(input.files[0]);
        msg.textContent = `${count} tickets loaded.`;
        msg.classList.add("ok");
        input.value = "";
        await refreshDashboard();
      } catch (err) {
        msg.textContent = err.message || "Import failed.";
        msg.classList.add("err");
      }
    });

    document.getElementById("btn-sync-now").addEventListener("click", async () => {
      const msg = document.getElementById("sync-result");
      msg.className = "admin-msg";
      saveAdminSettings();
      if (!TicketDB.getSyncUrl()) {
        msg.textContent = "Enter the Apps Script Web App URL first.";
        msg.classList.add("err");
        return;
      }
      if (!navigator.onLine) {
        msg.textContent = "You are offline. Connect to the internet to sync.";
        msg.classList.add("err");
        return;
      }
      msg.textContent = "Syncing…";
      try {
        const result = await TicketSync.runFullSync();
        msg.textContent = formatSyncResult(result);
        msg.classList.add("ok");
        await refreshDashboard();
      } catch (err) {
        msg.textContent = err.message || "Sync failed.";
        msg.classList.add("err");
      }
    });

    document.getElementById("btn-sync-download").addEventListener("click", async () => {
      const msg = document.getElementById("sync-result");
      msg.className = "admin-msg";
      saveAdminSettings();
      if (!TicketDB.getSyncUrl()) {
        msg.textContent = "Enter the Apps Script Web App URL first.";
        msg.classList.add("err");
        return;
      }
      if (!navigator.onLine) {
        msg.textContent = "You are offline. Connect to the internet to sync.";
        msg.classList.add("err");
        return;
      }
      msg.textContent = "Downloading…";
      try {
        const result = await TicketSync.downloadTickets();
        msg.textContent = `Downloaded ${result.downloaded} tickets.`;
        msg.classList.add("ok");
        await refreshDashboard();
      } catch (err) {
        msg.textContent = err.message || "Download failed.";
        msg.classList.add("err");
      }
    });

    window.addEventListener("online", async () => {
      updateNetworkStatus();
      if (TicketDB.getSyncUrl()) {
        await TicketSync.onOnline();
        await refreshDashboard();
      }
    });
    window.addEventListener("offline", updateNetworkStatus);

    window.onSyncComplete = refreshDashboard;

    async function runExport(fn, label) {
      const msg = document.getElementById("export-result");
      msg.className = "admin-msg";
      try {
        const n = await fn();
        msg.textContent = `Exported ${n} ${label}.`;
        msg.classList.add("ok");
      } catch (err) {
        msg.textContent = err.message || "Export failed.";
        msg.classList.add("err");
      }
    }

    document
      .getElementById("btn-export-checkins-csv")
      .addEventListener("click", () => runExport(() => TicketDB.exportCsv(true), "check-ins (CSV)"));
    document
      .getElementById("btn-export-checkins-json")
      .addEventListener("click", () => runExport(() => TicketDB.exportJson(true), "check-ins (JSON)"));
    document
      .getElementById("btn-export-backup-csv")
      .addEventListener("click", () => runExport(() => TicketDB.exportCsv(false), "tickets (CSV)"));
    document
      .getElementById("btn-export-backup-json")
      .addEventListener("click", () => runExport(() => TicketDB.exportJson(false), "tickets (JSON)"));

    document.getElementById("btn-clear-db").addEventListener("click", async () => {
      const ok = confirm(
        "Clear ALL local tickets and check-in records? This cannot be undone."
      );
      if (!ok) return;
      const ok2 = confirm("Are you sure? Export a backup first if you need the data.");
      if (!ok2) return;
      await TicketDB.clearAllTickets();
      document.getElementById("import-result").textContent = "Local database cleared.";
      document.getElementById("import-result").className = "admin-msg ok";
      await refreshDashboard();
    });

    window.addEventListener("beforeunload", (e) => {
      if (currentView === "scanner" && scanning) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((err) => {
        console.warn("SW registration failed:", err);
      });
    });
  }

  async function init() {
    bindEvents();
    registerServiceWorker();
    try {
      await TicketDB.openDb();
    } catch (err) {
      alert(err.message || "Could not open the ticket database.");
    }
    await refreshDashboard();
    if (navigator.onLine && TicketDB.getSyncUrl()) {
      TicketSync.onOnline().then(() => refreshDashboard()).catch(() => {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
