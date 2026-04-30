// ================================================================
//  DELIVERY MANAGER — WEB APP API  v2.0
//  Deploy as a SEPARATE Apps Script project:
//  → Go to script.google.com → New Project → paste this → Deploy
// ================================================================

// ── CONFIGURATION ── Edit this section only ─────────────────────
const CFG = {

  AUTH_TOKEN: "YOUR_AUTH_TOKEN_HERE",  // ← pick any secret string

  MAIN: {
    id:       "YOUR_MAIN_SHEET_ID_HERE",  // ← open your main sheet URL, copy the ID between /d/ and /edit
    dataTab:  "Delivery",   // confirmed tab name
    priceTab: "PriceList",
  },

  // Add / remove sellers here. That's all you ever need to change.
  SELLERS: [
    { name: "Talha",  id: "SHEET_ID", deduction: 40 },
    { name: "Asad",   id: "SHEET_ID", deduction: 40 },
    { name: "Usman",  id: "SHEET_ID", deduction: 40 },
    { name: "Ammar",  id: "SHEET_ID", deduction: 40 },
    { name: "Nouman", id: "SHEET_ID", deduction: 40 },
    // { name: "NewSeller", id: "SHEET_ID", deduction: 40 },
  ],

  // Add / remove buyers here.
  BUYERS: [
    { name: "Shoaib", id: "SHEET_ID" },
    // { name: "AnotherBuyer", id: "SHEET_ID" },
  ],

  // Twilio — for weekly report WhatsApp message
  TWILIO: {
    sid:   "YOUR_TWILIO_SID",
    token: "YOUR_TWILIO_TOKEN",
    from:  "whatsapp:+14155238886",
    to:    "whatsapp:+923161545875",
  },
};
// ── END CONFIGURATION ────────────────────────────────────────────


// ── UTILITY HELPERS ──────────────────────────────────────────────

var _gasEvent = null;

function respond(data, isOk) {
  const payload = isOk === false
    ? { ok: false, error: data }
    : { ok: true,  data:  data };
  const json = JSON.stringify(payload);
  const cb = _gasEvent && _gasEvent.parameter && _gasEvent.parameter.callback;
  if (cb) {
    return ContentService.createTextOutput(cb + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
const ok  = d  => respond(d, true);
const err = msg => respond(msg, false);

function checkAuth(e) {
  const token = e.parameter && e.parameter.token;
  return token === CFG.AUTH_TOKEN;
}

function tryParse(str) {
  try { return JSON.parse(str || "{}"); } catch (_) { return {}; }
}

// All requests come in as GET. Read-only actions use `action` param.
// Write actions pass a JSON body in the `body` param.
function getBody(e) {
  const raw = e.parameter && e.parameter.body;
  return raw ? tryParse(raw) : {};
}

function openSheet(ssId, tabName) {
  const ss = SpreadsheetApp.openById(ssId);
  const sh = tabName ? ss.getSheetByName(tabName) : ss.getSheets()[0];
  if (!sh) throw new Error(`Tab "${tabName}" not found in spreadsheet ${ssId}`);
  return sh;
}

function todayStr() {
  const d = new Date();
  return `${d.getDate()}/${d.getMonth()+1}/${String(d.getFullYear()).slice(2)}`;
}

function findPersonCfg(name) {
  const nameLow = name.toLowerCase();
  const seller = CFG.SELLERS.find(s => s.name.toLowerCase() === nameLow);
  const buyer  = CFG.BUYERS.find(b  => b.name.toLowerCase() === nameLow);
  return { seller, buyer, found: seller || buyer };
}


// ── doGet — ALL endpoints (frontend sends everything via GET) ────
// Usage: ?action=rows|pricelist|sheets|sheetRows|updateSheetRow|deleteSheetRow|...&token=YOUR_TOKEN

function doGet(e) {
  _gasEvent = e;
  if (!checkAuth(e)) return err("Unauthorized");
  const action = (e.parameter && e.parameter.action) || "";
  const body = getBody(e);
  
  try {
    // Read actions
    if (action === "rows")      return actionGetRows();
    if (action === "pricelist") return actionGetPriceList();
    if (action === "sheets")    return actionGetSheets();
    
    // Individual sheet actions (NEW)
    if (action === "sheetRows")      return actionGetSheetRows(body);
    if (action === "updateSheetRow") return actionUpdateSheetRow(body);
    if (action === "deleteSheetRow") return actionDeleteSheetRow(body);
    
    // Write actions (also handled via GET with body param)
    if (action === "appendRows")   return actionAppendRows(body);
    if (action === "updateRow")    return actionUpdateRow(body);
    if (action === "deleteRow")    return actionDeleteRow(body);
    if (action === "payment")      return actionRecordPayment(body);
    if (action === "addPrice")     return actionUpsertPrice(body, "add");
    if (action === "updatePrice")  return actionUpsertPrice(body, "update");
    if (action === "deletePrice")  return actionDeletePrice(body);
    if (action === "syncPrices")   return actionSyncPrices();
    if (action === "weeklyReport") return actionWeeklyReport();
    
    return err("Unknown action: " + action);
  } catch (ex) {
    return err(ex.message);
  }
}

function actionGetRows() {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.dataTab);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return ok([]);
  const headers = data[0];
  const rows = data.slice(1).map((r, i) => {
    const obj = { _row: i + 2 }; // actual sheet row number
    headers.forEach((h, j) => { obj[h] = r[j] !== undefined ? r[j] : ""; });
    return obj;
  });
  return ok(rows);
}

function actionGetPriceList() {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.priceTab);
  const last = sh.getLastRow();
  if (last < 2) return ok([]);
  const data = sh.getRange("A2:B" + last).getValues().filter(r => r[0]);
  return ok(data.map(r => ({ device: r[0], price: r[1] })));
}

function actionGetSheets() {
  return ok({
    sellers: CFG.SELLERS.map(s => ({ name: s.name, deduction: s.deduction })),
    buyers:  CFG.BUYERS.map(b  => ({ name: b.name })),
  });
}


// ── INDIVIDUAL SHEET ACTIONS (NEW) ────────────────────────────────

/**
 * Get all rows from a specific buyer/seller sheet.
 * body.sheet = "Talha" | "Shoaib" | etc.
 */
function actionGetSheetRows(body) {
  const sheetName = body.sheet;
  if (!sheetName) throw new Error("Missing sheet name");
  
  const { found } = findPersonCfg(sheetName);
  if (!found) throw new Error("Sheet not found in config: " + sheetName);
  
  const sh = openSheet(found.id, null); // first tab
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return ok([]);
  
  const headers = data[0];
  const rows = data.slice(1).map((r, i) => {
    const obj = { _row: i + 2 }; // actual sheet row number
    headers.forEach((h, j) => { obj[h] = r[j] !== undefined ? r[j] : ""; });
    return obj;
  });
  return ok(rows);
}

/**
 * Update specific cells in a row of a buyer/seller sheet.
 * body.sheet = "Talha", body.row = row number, body.data = { colName: newValue }
 */
function actionUpdateSheetRow(body) {
  const sheetName = body.sheet;
  if (!sheetName) throw new Error("Missing sheet name");
  
  const { found } = findPersonCfg(sheetName);
  if (!found) throw new Error("Sheet not found in config: " + sheetName);
  
  const sh = openSheet(found.id, null);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  
  Object.entries(body.data).forEach(([col, val]) => {
    const idx = headers.indexOf(col);
    if (idx > -1) sh.getRange(body.row, idx + 1).setValue(val);
  });
  
  return ok({ updated: body.row, sheet: sheetName });
}

/**
 * Delete a row from a buyer/seller sheet.
 * body.sheet = "Talha", body.row = row number
 */
function actionDeleteSheetRow(body) {
  const sheetName = body.sheet;
  if (!sheetName) throw new Error("Missing sheet name");
  
  const { found } = findPersonCfg(sheetName);
  if (!found) throw new Error("Sheet not found in config: " + sheetName);
  
  const sh = openSheet(found.id, null);
  sh.deleteRow(body.row);
  
  return ok({ deleted: body.row, sheet: sheetName });
}


// ── doPost — WRITE endpoints (kept for backward compatibility) ───
// Body must always include: { "token": "YOUR_TOKEN", "action": "...", ...data }

function doPost(e) {
  _gasEvent = e;
  if (!checkAuth(e)) return err("Unauthorized");
  const body = tryParse(e.postData && e.postData.contents);
  const action = body.action || "";
  try {
    if (action === "appendRows")   return actionAppendRows(body);
    if (action === "updateRow")    return actionUpdateRow(body);
    if (action === "deleteRow")    return actionDeleteRow(body);
    if (action === "payment")      return actionRecordPayment(body);
    if (action === "addPrice")     return actionUpsertPrice(body, "add");
    if (action === "updatePrice")  return actionUpsertPrice(body, "update");
    if (action === "deletePrice")  return actionDeletePrice(body);
    if (action === "syncPrices")   return actionSyncPrices();
    if (action === "weeklyReport") return actionWeeklyReport();
    // Individual sheet actions
    if (action === "sheetRows")      return actionGetSheetRows(body);
    if (action === "updateSheetRow") return actionUpdateSheetRow(body);
    if (action === "deleteSheetRow") return actionDeleteSheetRow(body);
    return err("Unknown POST action: " + action);
  } catch (ex) {
    return err(ex.message);
  }
}


// ── DELIVERIES ────────────────────────────────────────────────────

/**
 * Append one or more delivery rows.
 * body.rows = [ { "Date":"...", "Device":"...", "Buyer":"...", ... }, ... ]
 */
function actionAppendRows(body) {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.dataTab);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = Array.isArray(body.rows) ? body.rows : [body.rows];
  const toWrite = rows.map(r => headers.map(h => (r[h] !== undefined ? r[h] : "")));
  sh.getRange(sh.getLastRow() + 1, 1, toWrite.length, headers.length).setValues(toWrite);
  return ok({ appended: toWrite.length });
}

/**
 * Update specific cells in an existing row.
 * body.row = sheet row number (from _row field), body.data = { colName: newValue }
 */
function actionUpdateRow(body) {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.dataTab);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.entries(body.data).forEach(([col, val]) => {
    const idx = headers.indexOf(col);
    if (idx > -1) sh.getRange(body.row, idx + 1).setValue(val);
  });
  return ok({ updated: body.row });
}

/**
 * Delete a row by sheet row number.
 * body.row = sheet row number
 */
function actionDeleteRow(body) {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.dataTab);
  sh.deleteRow(body.row);
  return ok({ deleted: body.row });
}


// ── PAYMENTS ─────────────────────────────────────────────────────

/**
 * Record a payment row in a buyer's or seller's sheet.
 * body = { person: "Talha", amount: 500, currency: "EUR"|"PKR", note: "...", direction: "to"|"from" }
 */
function actionRecordPayment(body) {
  const { seller, buyer, found } = findPersonCfg(body.person);
  if (!found) throw new Error("Person not found in config: " + body.person);

  const sh = openSheet(found.id, null); // first tab of their sheet
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // Build a blank row then fill known columns
  const row = headers.map(() => "");
  const set = (name, val) => {
    const i = headers.indexOf(name);
    if (i > -1) row[i] = val;
  };

  const amtStr = body.currency === "PKR"
    ? body.amount + " PKR"
    : "€" + body.amount;

  set("Date",   todayStr());
  set("Device", "── PAYMENT ──");
  set(seller ? "Seller" : "Buyer", body.person);
  set("Paid",   amtStr);
  set("Balance", body.note || "");
  if (body.currency === "EUR") set("Paid(EUR)", amtStr);

  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return ok({ recorded: true, person: body.person, amount: amtStr });
}


// ── PRICE LIST ────────────────────────────────────────────────────

/**
 * Add a new device or update an existing one.
 * body = { device: "IPhone 17 256gb", price: 440 }
 * mode: "add" | "update"
 */
function actionUpsertPrice(body, mode) {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.priceTab);
  const last = sh.getLastRow();
  const data = last >= 2 ? sh.getRange("A2:A" + last).getValues() : [];
  let foundRow = -1;
  data.forEach((r, i) => {
    if (r[0] && r[0].toString().toLowerCase() === body.device.toLowerCase()) foundRow = i + 2;
  });

  if (mode === "add" && foundRow > -1)  throw new Error("Device already exists — use updatePrice instead.");
  if (mode === "update" && foundRow === -1) throw new Error("Device not found — use addPrice instead.");

  if (foundRow > -1) {
    sh.getRange(foundRow, 2).setValue(body.price);
    return ok({ action: "updated", device: body.device, price: body.price });
  } else {
    sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[body.device, body.price]]);
    return ok({ action: "added", device: body.device, price: body.price });
  }
}

/**
 * Remove a device from the price list.
 * body = { device: "IPhone 17 256gb" }
 */
function actionDeletePrice(body) {
  const sh = openSheet(CFG.MAIN.id, CFG.MAIN.priceTab);
  const last = sh.getLastRow();
  const data = last >= 2 ? sh.getRange("A2:A" + last).getValues() : [];
  let foundRow = -1;
  data.forEach((r, i) => {
    if (r[0] && r[0].toString().toLowerCase() === body.device.toLowerCase()) foundRow = i + 2;
  });
  if (foundRow === -1) throw new Error("Device not found: " + body.device);
  sh.deleteRow(foundRow);
  return ok({ deleted: body.device });
}


// ── PRICE SYNC ────────────────────────────────────────────────────

/**
 * Push main PriceList to all seller sheets with their deductions applied.
 * No body params needed — reads CFG.SELLERS automatically.
 */
function actionSyncPrices() {
  const mainSS   = SpreadsheetApp.openById(CFG.MAIN.id);
  const priceSh  = mainSS.getSheetByName(CFG.MAIN.priceTab);
  const srcData  = priceSh.getRange("A2:B" + priceSh.getLastRow()).getValues();
  const results  = [];

  CFG.SELLERS.forEach(seller => {
    try {
      const ss = SpreadsheetApp.openById(seller.id);
      const sh = ss.getSheetByName(CFG.MAIN.priceTab);
      if (!sh) { results.push({ name: seller.name, status: "no PriceList tab" }); return; }

      const prices = srcData
        .filter(r => r[0])
        .map(r => {
          const base = parseFloat(r[1]);
          return [r[0], isNaN(base) ? "" : base - seller.deduction];
        });

      sh.getRange("A2:B").clearContent();
      if (prices.length) sh.getRange(2, 1, prices.length, 2).setValues(prices);
      results.push({ name: seller.name, status: "ok", rows: prices.length });
    } catch (ex) {
      results.push({ name: seller.name, status: "error: " + ex.message });
    }
  });

  return ok({ sync: results });
}


// ── WEEKLY REPORT ─────────────────────────────────────────────────

/**
 * Generate last week's report and send via Twilio WhatsApp.
 * Reads from the main delivery sheet — no active sheet dependency.
 */
function actionWeeklyReport() {
  const mainSS    = SpreadsheetApp.openById(CFG.MAIN.id);
  const dataSh    = mainSS.getSheetByName(CFG.MAIN.dataTab);
  const priceSh   = mainSS.getSheetByName(CFG.MAIN.priceTab);

  // Date range: last Monday → last Sunday
  const today   = new Date();
  const dow     = today.getDay();
  const offset  = (dow === 0 ? 6 : dow - 1) + 7;
  const start   = new Date(today); start.setDate(today.getDate() - offset); start.setHours(0,0,0,0);
  const end     = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
  const dateStr = start.toLocaleDateString() + " – " + end.toLocaleDateString();

  // Price map
  const priceMap = {};
  priceSh.getRange("A2:B" + priceSh.getLastRow()).getValues().forEach(r => {
    if (r[0]) priceMap[r[0].toString().toUpperCase().trim()] = parseFloat(r[1]) || 0;
  });

  // Header map
  const allRows  = dataSh.getDataRange().getValues();
  const headers  = allRows[0];
  const col      = name => headers.indexOf(name);

  const report = {};
  allRows.slice(1).forEach(r => {
    const rowDate = new Date(r[col("Date")]);
    const device  = (r[col("Device")] || "").toString().toUpperCase().trim();
    const buyer   = (r[col("Buyer")]  || "").toString().trim();
    const seller  = (r[col("Seller")] || "").toString().trim();
    if (rowDate < start || rowDate > end || !device || !priceMap[device]) return;

    const base = priceMap[device];
    if (buyer) {
      if (!report[buyer]) report[buyer] = { devices:{}, total:0, isBuyer:true };
      report[buyer].devices[device] = (report[buyer].devices[device] || 0) + 1;
      report[buyer].total += base;
    }
    if (seller) {
      if (!report[seller]) report[seller] = { devices:{}, total:0, isBuyer:false };
      report[seller].devices[device] = (report[seller].devices[device] || 0) + 1;
      const ded = (CFG.SELLERS.find(s => s.name === seller) || {}).deduction ?? 40;
      report[seller].total += (base - ded);
    }
  });

  // Format message
  let msg = `*WEEKLY REPORT* (${dateStr})\n==========================\n`;
  Object.entries(report).forEach(([name, data]) => {
    msg += `\n*${name.toUpperCase()}:*\n`;
    Object.entries(data.devices).forEach(([dev, qty]) => { msg += `${qty} x ${dev}\n`; });
    msg += `TOTAL: EUR ${data.total.toLocaleString()}\n--------------------------\n`;
  });

  // Send via Twilio
  const resp = UrlFetchApp.fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${CFG.TWILIO.sid}/Messages.json`,
    {
      method: "post",
      headers: { Authorization: "Basic " + Utilities.base64Encode(CFG.TWILIO.sid + ":" + CFG.TWILIO.token) },
      payload: { To: CFG.TWILIO.to, From: CFG.TWILIO.from, Body: msg },
      muteHttpExceptions: true,
    }
  );

  const code = resp.getResponseCode();
  if (code !== 200 && code !== 201)
    throw new Error("Twilio error " + code + ": " + resp.getContentText());

  return ok({ sent: true, report: msg });
}
