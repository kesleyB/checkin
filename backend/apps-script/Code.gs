/**
 * JCF CONCERT Check-In — Google Apps Script Web App
 *
 * Deploy as Web App: Execute as Me, Access Anyone with the link.
 *
 * Endpoints (single deployment URL):
 *   GET  ?action=tickets
 *   POST { "action": "checkin", "ticketId", "checkedInAt", "deviceId" }
 */

var SHEET_NAME = "Tickets";

// Column indices (1-based) on Tickets tab
var COL = {
  TICKET_ID: 1, // A
  ORDER_ID: 2, // B
  BUYER_NAME: 3, // C
  TICKET_TYPE: 4, // D
  STATUS: 5, // E
  QR_DATA: 6, // F
  GENERATED_AT: 7, // G — not exported
  CHECKED_IN_AT: 8, // H
};

function doGet(e) {
  try {
    var action = (e.parameter.action || "").toLowerCase();
    if (action === "tickets") {
      return jsonResponse_(getTickets_());
    }
    return jsonResponse_({ ok: false, error: "Unknown action. Use ?action=tickets" }, 400);
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) }, 500);
  }
}

function doPost(e) {
  try {
    var body = {};
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = (body.action || "").toLowerCase();
    if (action === "checkin") {
      return jsonResponse_(checkInTicket_(body));
    }
    return jsonResponse_({ ok: false, error: "Unknown action. Use action=checkin" }, 400);
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) }, 500);
  }
}

function getTicketsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + SHEET_NAME + '" not found.');
  }
  return sheet;
}

function normalizeId_(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeStatus_(value) {
  var s = String(value || "UNUSED")
    .trim()
    .toUpperCase();
  if (s === "USED") return "USED";
  return "UNUSED";
}

function emptyToNull_(value) {
  var s = String(value || "").trim();
  return s ? s : null;
}

function getTickets_() {
  var sheet = getTicketsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { ok: true, tickets: [], syncedAt: new Date().toISOString() };
  }

  var data = sheet.getRange(2, 1, lastRow - 1, COL.CHECKED_IN_AT).getValues();
  var tickets = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var ticketId = normalizeId_(row[COL.TICKET_ID - 1]);
    if (!ticketId) continue;

    var status = normalizeStatus_(row[COL.STATUS - 1]);
    var checkedInAt = emptyToNull_(row[COL.CHECKED_IN_AT - 1]);
    if (status === "UNUSED") checkedInAt = null;

    var qrRaw = row[COL.QR_DATA - 1];
    var qrData = normalizeId_(qrRaw) || ticketId;

    tickets.push({
      ticketId: ticketId,
      orderId: emptyToNull_(row[COL.ORDER_ID - 1]),
      buyerName: String(row[COL.BUYER_NAME - 1] || "").trim(),
      ticketType: String(row[COL.TICKET_TYPE - 1] || "").trim(),
      status: status,
      qrData: qrData,
      checkedInAt: checkedInAt,
    });
  }

  return {
    ok: true,
    tickets: tickets,
    syncedAt: new Date().toISOString(),
  };
}

function checkInTicket_(body) {
  var ticketId = normalizeId_(body.ticketId);
  if (!ticketId) {
    return { ok: false, error: "Missing ticketId" };
  }

  var checkedInAt = String(body.checkedInAt || new Date().toISOString()).trim();
  var deviceId = String(body.deviceId || "UNKNOWN").trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var sheet = getTicketsSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { ok: false, error: "No tickets in sheet" };
    }

    var ticketCol = sheet.getRange(2, COL.TICKET_ID, lastRow - 1, 1).getValues();
    var rowIndex = -1;

    for (var i = 0; i < ticketCol.length; i++) {
      if (normalizeId_(ticketCol[i][0]) === ticketId) {
        rowIndex = i + 2;
        break;
      }
    }

    if (rowIndex === -1) {
      return { ok: false, code: "NOT_FOUND", error: "Ticket not found: " + ticketId };
    }

    var statusCell = sheet.getRange(rowIndex, COL.STATUS);
    var currentStatus = normalizeStatus_(statusCell.getValue());

    if (currentStatus === "USED") {
      var existingCheckedIn = emptyToNull_(
        sheet.getRange(rowIndex, COL.CHECKED_IN_AT).getValue()
      );
      return {
        ok: false,
        code: "ALREADY_USED",
        ticketId: ticketId,
        status: "USED",
        checkedInAt: existingCheckedIn,
      };
    }

    statusCell.setValue("USED");
    sheet.getRange(rowIndex, COL.CHECKED_IN_AT).setValue(checkedInAt);

    // Optional: append deviceId to Notes column if present (column J = 10)
    try {
      var notesCol = 10;
      var notesCell = sheet.getRange(rowIndex, notesCol);
      var prev = String(notesCell.getValue() || "").trim();
      var note = "Checked in via " + deviceId;
      notesCell.setValue(prev ? prev + " | " + note : note);
    } catch (noteErr) {
      /* Notes column optional */
    }

    return {
      ok: true,
      ticketId: ticketId,
      status: "USED",
      checkedInAt: checkedInAt,
    };
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse_(obj, statusCode) {
  var output = ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
  return output;
}
