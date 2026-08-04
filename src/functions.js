const db = require('./sheetsClient');
const { saveSignatureImage } = require('./drive');
const mutex = require('./mutex');

const CONFIG = {
  SHEET_MASTER: 'MasterItems',
  SHEET_SUBMISSIONS: 'Submissions',
  SHEET_ITEMS: 'SubmissionItems',
  SHEET_EDITREQ: 'EditRequests',
  SHEET_DRAFTS: 'Drafts',
  SHEET_RECEIVING: 'ReceivingLogs', // <-- เพิ่มระบบรับเข้า (Receiving)
  ARCHIVE_PREFIX: 'ตรวจนับ_',
  TIMEZONE: 'Asia/Bangkok',
  REVIEWER_PIN: process.env.REVIEWER_PIN || '1212312121',
  ADMIN_PIN: process.env.ADMIN_PIN || '1212312121',
  DEFAULT_UNIT: 'ขวด'
};

function thaiDate(isoOrAny) {
  if (!isoOrAny) return '';
  const d = new Date(isoOrAny);
  if (isNaN(d.getTime())) return String(isoOrAny);
  return d.toLocaleString('th-TH', { timeZone: CONFIG.TIMEZONE });
}
function nowIso() { return new Date().toISOString(); }

/* ============================================================
   ensureSheets_ : สร้างชีทที่จำเป็นถ้ายังไม่มี (เรียกครั้งเดียวตอน boot ก็พอ
   แต่คงพฤติกรรมเดิมไว้โดยเช็คทุกครั้งที่เรียกฟังก์ชันหลัก)
   ============================================================ */
let ensured = false;
async function ensureSheets_() {
  if (ensured) return; // เช็คครั้งเดียวต่อการรันโปรเซส พอสำหรับ use case นี้
  const names = await db.listSheetNames();

  if (names.indexOf(CONFIG.SHEET_MASTER) === -1) {
    await db.createSheet(CONFIG.SHEET_MASTER,
      ['code', 'name', 'manufacturer', 'productCodes(คั่นด้วย ;)', 'qty', 'note', 'unit']);
  }
  if (names.indexOf(CONFIG.SHEET_SUBMISSIONS) === -1) {
    await db.createSheet(CONFIG.SHEET_SUBMISSIONS,
      ['submissionId', 'submittedAt', 'employeeName', 'employeeSignatureUrl', 'status', 'reviewerName', 'reviewerSignatureUrl', 'reviewedAt', 'discrepancyCount', 'itemCount']);
  }
  if (names.indexOf(CONFIG.SHEET_ITEMS) === -1) {
    await db.createSheet(CONFIG.SHEET_ITEMS,
      ['submissionId', 'code', 'name', 'manufacturer', 'expectedQty', 'actualQty', 'openBottles', 'remark', 'hasDiscrepancy', 'unit', 'usedQty', 'remainingApprox', 'checkedAt', 'qrCode']);
  }
  if (names.indexOf(CONFIG.SHEET_EDITREQ) === -1) {
    await db.createSheet(CONFIG.SHEET_EDITREQ,
      ['requestId', 'type', 'submissionId', 'itemCode', 'itemName', 'requestNote', 'addCodes', 'removeCodes', 'requesterName', 'requestedAt', 'status', 'resolvedBy', 'resolvedAt', 'addReason', 'removeReason']);
  }
  if (names.indexOf(CONFIG.SHEET_DRAFTS) === -1) {
    await db.createSheet(CONFIG.SHEET_DRAFTS, ['employeeName', 'updatedAt', 'itemsStateJson']);
  }
  ensured = true;
}

function checkPin_(pin) { if (String(pin) !== String(CONFIG.REVIEWER_PIN)) throw new Error('รหัส PIN ไม่ถูกต้อง'); }
function checkAdminPin_(pin) { if (String(pin) !== String(CONFIG.ADMIN_PIN)) throw new Error('รหัส PIN ไม่ถูกต้อง'); }

/* ============================================================ Master items ============================================================ */
async function getMasterItemsWithRow_() {
  await ensureSheets_();
  const rows = await db.getDataRange(CONFIG.SHEET_MASTER);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[1]) continue;
    out.push({
      rowIndex: i + 1,
      code: String(r[0] || '-'), name: String(r[1]), manufacturer: String(r[2] || ''),
      productCodes: String(r[3] || '').split(';').filter(x => x),
      qty: Number(r[4]) || 0, note: String(r[5] || ''),
      unit: String(r[6] || '') || CONFIG.DEFAULT_UNIT
    });
  }
  return out;
}

async function getMasterItems() {
  const withRow = await getMasterItemsWithRow_();
  return withRow.map(({ rowIndex, ...rest }) => rest);
}

/* ============================================================ Drafts ============================================================ */
async function saveDraft(employeeName, itemsStateJson) {
  await ensureSheets_();
  employeeName = String(employeeName || '').trim();
  if (!employeeName) throw new Error('กรุณาระบุชื่อ-สกุลผู้ตรวจนับก่อนบันทึกความคืบหน้า');
  return mutex.runExclusive(async () => {
    const rows = await db.getDataRange(CONFIG.SHEET_DRAFTS);
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim().toLowerCase() === employeeName.toLowerCase()) { rowIdx = i + 1; break; }
    }
    const now = nowIso();
    if (rowIdx === -1) {
      await db.appendRow(CONFIG.SHEET_DRAFTS, [employeeName, now, itemsStateJson]);
    } else {
      await db.setRange(CONFIG.SHEET_DRAFTS, rowIdx, 2, [[now, itemsStateJson]]);
    }
    return { success: true, savedAt: thaiDate(now) };
  });
}

async function getDraft(employeeName) {
  await ensureSheets_();
  employeeName = String(employeeName || '').trim();
  if (!employeeName) return null;
  const rows = await db.getDataRange(CONFIG.SHEET_DRAFTS);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === employeeName.toLowerCase()) {
      return {
        employeeName: String(rows[i][0]),
        updatedAt: thaiDate(rows[i][1]),
        itemsStateJson: String(rows[i][2] || '{}')
      };
    }
  }
  return null;
}

async function deleteDraft_(employeeName) {
  employeeName = String(employeeName || '').trim();
  if (!employeeName) return;
  const rows = await db.getDataRange(CONFIG.SHEET_DRAFTS);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim().toLowerCase() === employeeName.toLowerCase()) {
      await db.deleteRow(CONFIG.SHEET_DRAFTS, i + 1);
      return;
    }
  }
}

/* ============================================================ Submit checklist ============================================================ */
async function submitChecklist(payload) {
  await ensureSheets_();
  if (!payload || !payload.employeeName || !payload.signatureBase64 || !payload.items || !payload.items.length) {
    throw new Error('ข้อมูลไม่ครบถ้วน');
  }
  const uncheckedCount = payload.items.filter(it => !it.checked).length;
  if (uncheckedCount > 0) {
    throw new Error(`กรุณายืนยันการตรวจนับให้ครบทุกรายการก่อนส่งใบตรวจนับ (ยังเหลืออีก ${uncheckedCount} รายการที่ยังไม่ได้ยืนยัน)`);
  }

  return mutex.runExclusive(async () => {
    const submissionId = 'SUB' + Date.now();
    const now = nowIso();
    const sigUrl = await saveSignatureImage(payload.signatureBase64, submissionId + '_employee');

    let discCount = 0;
    const rows = payload.items.map(it => {
      const hasDisc = Number(it.actualQty) !== Number(it.expectedQty);
      if (hasDisc) discCount++;
      return [
        submissionId, it.code, it.name, it.manufacturer, it.expectedQty, it.actualQty,
        (it.openBottles || []).join(';'), it.remark || '', hasDisc,
        it.unit || CONFIG.DEFAULT_UNIT, Number(it.usedQty) || 0, it.remainingApprox || '',
        it.checkedAt ? new Date(it.checkedAt).toISOString() : '',
        it.qrCode || ''
      ];
    });
    await db.appendRows(CONFIG.SHEET_ITEMS, rows);
    await db.appendRow(CONFIG.SHEET_SUBMISSIONS,
      [submissionId, now, payload.employeeName, sigUrl, 'รอตรวจสอบ', '', '', '', discCount, payload.items.length]);

    await deleteDraft_(payload.employeeName);
    return { success: true, submissionId };
  });
}

/* ============================================================ Review (reviewer PIN) ============================================================ */
async function getPendingSubmissions(pin) {
  checkPin_(pin);
  await ensureSheets_();
  const data = await db.getDataRange(CONFIG.SHEET_SUBMISSIONS);
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (r.length < 5) continue;
    const status = String(r[4] || '');
    if (status.indexOf('รอ') !== -1) {
      out.push({
        submissionId: String(r[0] || ''),
        submittedAt: thaiDate(r[1]),
        employeeName: String(r[2] || ''),
        discrepancyCount: Number(r[8] || 0),
        itemCount: Number(r[9] || 0)
      });
    }
  }
  out.sort((a, b) => b.submissionId.localeCompare(a.submissionId));
  return out;
}

async function getSubmissionDetail(pin, submissionId) {
  checkPin_(pin);
  await ensureSheets_();
  const subsRows = await db.getDataRange(CONFIG.SHEET_SUBMISSIONS);
  let header = null;
  for (let i = 1; i < subsRows.length; i++) {
    if (String(subsRows[i][0]) === String(submissionId)) { header = subsRows[i]; break; }
  }
  if (!header) throw new Error('ไม่พบใบตรวจนับนี้');

  const itemRows = await db.getDataRange(CONFIG.SHEET_ITEMS);
  const items = [];
  for (let j = 1; j < itemRows.length; j++) {
    const r = itemRows[j];
    if (String(r[0]) === String(submissionId)) {
      items.push({
        code: String(r[1]), name: String(r[2]), manufacturer: String(r[3]), expectedQty: Number(r[4]),
        actualQty: Number(r[5]), openBottles: String(r[6] || '').split(';').filter(x => x),
        remark: String(r[7] || ''), hasDiscrepancy: Boolean(r[8]),
        unit: String(r[9] || '') || CONFIG.DEFAULT_UNIT,
        usedQty: Number(r[10]) || 0,
        remainingApprox: String(r[11] || ''),
        checkedAt: thaiDate(r[12]),
        qrCode: String(r[13] || '')
      });
    }
  }
  return {
    submissionId: String(header[0]), submittedAt: thaiDate(header[1]), employeeName: String(header[2]),
    employeeSignatureUrl: String(header[3] || ''), status: String(header[4]),
    reviewerName: String(header[5] || ''), reviewerSignatureUrl: String(header[6] || ''),
    items
  };
}

async function updateSubmissionItemDetail(pin, submissionId, itemCode, itemName, newData) {
  checkPin_(pin);
  await ensureSheets_();

  const subsRows = await db.getDataRange(CONFIG.SHEET_SUBMISSIONS);
  for (let s = 1; s < subsRows.length; s++) {
    if (String(subsRows[s][0]) === String(submissionId)) {
      if (String(subsRows[s][4]) === 'ตรวจสอบแล้ว') {
        throw new Error('ใบตรวจนับนี้อนุมัติไปแล้ว ไม่สามารถแก้ไขได้ กรุณาใช้ระบบขอแก้ไขรายละเอียดแทน');
      }
      break;
    }
  }

  return mutex.runExclusive(async () => {
    const rows = await db.getDataRange(CONFIG.SHEET_ITEMS);
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(submissionId) && String(rows[i][1]) === String(itemCode) && String(rows[i][2]) === String(itemName)) {
        const rowIdx = i + 1;
        const newName = (newData.name !== undefined && String(newData.name).trim() !== '') ? newData.name : rows[i][2];
        const newMfr = (newData.manufacturer !== undefined) ? newData.manufacturer : rows[i][3];
        const newActual = (newData.actualQty !== undefined && newData.actualQty !== '') ? Number(newData.actualQty) : Number(rows[i][5]);
        const newRemark = (newData.remark !== undefined) ? newData.remark : rows[i][7];
        const newRemaining = (newData.remainingApprox !== undefined) ? newData.remainingApprox : rows[i][11];
        const expected = Number(rows[i][4]);

        await db.setCell(CONFIG.SHEET_ITEMS, rowIdx, 3, newName);
        await db.setCell(CONFIG.SHEET_ITEMS, rowIdx, 4, newMfr);
        await db.setCell(CONFIG.SHEET_ITEMS, rowIdx, 6, newActual);
        await db.setCell(CONFIG.SHEET_ITEMS, rowIdx, 8, newRemark);
        await db.setCell(CONFIG.SHEET_ITEMS, rowIdx, 9, newActual !== expected);
        await db.setCell(CONFIG.SHEET_ITEMS, rowIdx, 12, newRemaining);
        return getSubmissionDetail(pin, submissionId);
      }
    }
    throw new Error('ไม่พบรายการนี้ในใบตรวจนับ');
  });
}

async function approveSubmission(pin, submissionId, reviewerName, signatureBase64) {
  checkPin_(pin);
  if (!reviewerName || !signatureBase64) throw new Error('กรุณาระบุชื่อและเซ็นชื่อผู้ตรวจสอบ');
  await ensureSheets_();

  return mutex.runExclusive(async () => {
    const rows = await db.getDataRange(CONFIG.SHEET_SUBMISSIONS);
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) { if (String(rows[i][0]) === String(submissionId)) { rowIdx = i + 1; break; } }
    if (rowIdx === -1) throw new Error('ไม่พบใบตรวจนับนี้');

    const sigUrl = await saveSignatureImage(signatureBase64, submissionId + '_reviewer');
    const reviewedAt = nowIso();
    await db.setRange(CONFIG.SHEET_SUBMISSIONS, rowIdx, 5, [['ตรวจสอบแล้ว', reviewerName, sigUrl, reviewedAt]]);

    await archiveSubmission_(submissionId, reviewedAt);
    return { success: true };
  });
}

/* ============================================================ Archive (รายเดือน) ============================================================ */
function getMonthKey_(dateIso) {
  const d = new Date(dateIso);
  const y = d.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE, year: 'numeric' });
  const m = d.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE, month: '2-digit' });
  return `${y}-${m}`;
}
function getMonthLabelThai_(monthKey) {
  const thaiMonths = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const [y, m] = monthKey.split('-').map(Number);
  return `${thaiMonths[m - 1]} ${y + 543}`;
}

async function ensureArchiveSheet_(monthKey) {
  const sheetName = CONFIG.ARCHIVE_PREFIX + monthKey;
  const exists = await db.sheetExists(sheetName);
  if (!exists) {
    await db.createSheet(sheetName, [
      'submissionId', 'submittedAt', 'employeeName', 'reviewerName', 'reviewedAt',
      'itemCode', 'itemName', 'manufacturer', 'expectedQty', 'actualQty',
      'openBottles', 'remark', 'hasDiscrepancy', 'unit', 'usedQty', 'remainingApprox', 'checkedAt', 'qrCode'
    ]);
  }
  return sheetName;
}

async function isAlreadyArchived_(submissionId) {
  const names = await db.listSheetNames();
  for (const name of names) {
    if (name.indexOf(CONFIG.ARCHIVE_PREFIX) === 0) {
      const data = await db.getDataRange(name);
      for (let r = 1; r < data.length; r++) {
        if (String(data[r][0]) === String(submissionId)) return true;
      }
    }
  }
  return false;
}

async function archiveSubmission_(submissionId, reviewedAt) {
  if (await isAlreadyArchived_(submissionId)) return;

  const subsRows = await db.getDataRange(CONFIG.SHEET_SUBMISSIONS);
  let header = null;
  for (let i = 1; i < subsRows.length; i++) {
    if (String(subsRows[i][0]) === String(submissionId)) { header = subsRows[i]; break; }
  }
  if (!header) return;

  const employeeName = String(header[2] || '');
  const reviewerName = String(header[5] || '');
  const submittedAt = header[1];

  const monthKey = getMonthKey_(reviewedAt || nowIso());
  const sheetName = await ensureArchiveSheet_(monthKey);

  const itemRows = await db.getDataRange(CONFIG.SHEET_ITEMS);
  const rowsToAppend = [];
  for (let j = 1; j < itemRows.length; j++) {
    const r = itemRows[j];
    if (String(r[0]) === String(submissionId)) {
      rowsToAppend.push([
        submissionId, submittedAt, employeeName, reviewerName, reviewedAt,
        r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8],
        r[9] || CONFIG.DEFAULT_UNIT, Number(r[10]) || 0, r[11] || '', r[12] || '', r[13] || ''
      ]);
    }
  }
  if (rowsToAppend.length) await db.appendRows(sheetName, rowsToAppend);
}

async function getArchiveMonths() {
  const names = await db.listSheetNames();
  const months = [];
  for (const name of names) {
    if (name.indexOf(CONFIG.ARCHIVE_PREFIX) === 0) {
      const monthKey = name.substring(CONFIG.ARCHIVE_PREFIX.length);
      const data = await db.getDataRange(name);
      const submissionIds = {};
      let discCount = 0;
      for (let r = 1; r < data.length; r++) {
        submissionIds[String(data[r][0])] = true;
        if (data[r][12] === true) discCount++;
      }
      months.push({
        monthKey, label: getMonthLabelThai_(monthKey),
        submissionCount: Object.keys(submissionIds).length,
        itemCount: Math.max(0, data.length - 1),
        discrepancyCount: discCount
      });
    }
  }
  months.sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  return months;
}

async function getMonthlyRemainingSummary(monthKey) {
  await ensureSheets_();
  const master = await getMasterItemsWithRow_();
  const sheetName = CONFIG.ARCHIVE_PREFIX + monthKey;
  const exists = await db.sheetExists(sheetName);

  const latestByKey = {};
  if (exists) {
    const data = await db.getDataRange(sheetName);
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const key = String(row[5] || '-') + '|' + String(row[6] || '').trim().toLowerCase();
      const submissionId = String(row[0]);
      const existing = latestByKey[key];
      if (!existing || submissionId > existing.submissionId) {
        latestByKey[key] = {
          submissionId,
          manufacturer: String(row[7] || ''),
          expectedQty: Number(row[8]) || 0,
          actualQty: Number(row[9]) || 0,
          openBottles: String(row[10] || '').split(';').filter(x => x),
          remark: String(row[11] || ''),
          hasDiscrepancy: Boolean(row[12]),
          unit: String(row[13] || '') || CONFIG.DEFAULT_UNIT,
          usedQty: Number(row[14]) || 0,
          remainingApprox: String(row[15] || '')
        };
      }
    }
  }

  const out = master.map(it => {
    const key = it.code + '|' + it.name.trim().toLowerCase();
    const found = latestByKey[key];
    return {
      code: it.code, name: it.name,
      manufacturer: found ? found.manufacturer : it.manufacturer,
      productCodes: it.productCodes, unit: it.unit, docQty: it.qty,
      actualQty: found ? found.actualQty : null,
      openBottles: found ? found.openBottles : [],
      usedQty: found ? found.usedQty : 0,
      remainingApprox: found ? found.remainingApprox : '',
      remark: (found && found.remark) ? found.remark : it.note,
      hasDiscrepancy: found ? found.hasDiscrepancy : false,
      checked: !!found
    };
  });

  const checkedCount = out.filter(x => x.checked).length;
  const discCount = out.filter(x => x.hasDiscrepancy).length;

  return {
    monthKey, label: getMonthLabelThai_(monthKey), items: out,
    totals: { itemCount: out.length, checkedCount, discrepancyCount: discCount }
  };
}

/* ============================================================ Edit requests ============================================================ */
async function submitEditRequest(pin, payload) {
  checkPin_(pin);
  if (!payload || !payload.requestNote) throw new Error('กรุณาระบุรายละเอียดที่ต้องการแก้ไข');
  await ensureSheets_();
  const requestId = 'REQ' + Date.now();
  await db.appendRow(CONFIG.SHEET_EDITREQ,
    [requestId, 'review_note', payload.submissionId || '', payload.itemCode || '', payload.itemName || '',
      payload.requestNote, '', '', payload.reviewerName || '', nowIso(), 'รอดำเนินการ', '', '']);
  return { success: true };
}

async function requestCodeChange(payload) {
  if (!payload || !payload.itemName) throw new Error('ข้อมูลไม่ครบถ้วน');
  await ensureSheets_();
  const requestId = 'REQ' + Date.now();
  await db.appendRow(CONFIG.SHEET_EDITREQ, [
    requestId, 'code_change', '', payload.itemCode || '', payload.itemName, payload.note || '',
    (payload.addCodes || []).join(';'), (payload.removeCodes || []).join(';'),
    payload.requesterName || '', nowIso(), 'รอดำเนินการ', '', '',
    payload.addReason || '', payload.removeReason || ''
  ]);
  return { success: true };
}

async function getEditRequests(pin) {
  checkAdminPin_(pin);
  await ensureSheets_();
  const rows = await db.getDataRange(CONFIG.SHEET_EDITREQ);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[10]).indexOf('รอดำเนินการ') !== -1) {
      out.push({
        requestId: String(r[0]), type: String(r[1]), submissionId: String(r[2]), itemCode: String(r[3]), itemName: String(r[4]),
        requestNote: String(r[5]), addCodes: String(r[6] || '').split(';').filter(x => x),
        removeCodes: String(r[7] || '').split(';').filter(x => x),
        requesterName: String(r[8]), requestedAt: thaiDate(r[9]),
        addReason: String(r[13] || ''), removeReason: String(r[14] || '')
      });
    }
  }
  out.sort((a, b) => b.requestId.localeCompare(a.requestId));
  return out;
}

async function resolveEditRequest(pin, requestId, action) {
  checkAdminPin_(pin);
  await ensureSheets_();
  return mutex.runExclusive(async () => {
    const rows = await db.getDataRange(CONFIG.SHEET_EDITREQ);
    let rowIdx = -1, reqRow = null;
    for (let i = 1; i < rows.length; i++) { if (String(rows[i][0]) === String(requestId)) { rowIdx = i + 1; reqRow = rows[i]; break; } }
    if (rowIdx === -1) throw new Error('ไม่พบคำขอนี้');

    if (action === 'approve' && String(reqRow[1]) === 'code_change') {
      const addCodes = String(reqRow[6] || '').split(';').filter(x => x);
      const removeCodes = String(reqRow[7] || '').split(';').filter(x => x);
      const mRows = await db.getDataRange(CONFIG.SHEET_MASTER);
      const itemName = String(reqRow[4] || '').trim().toLowerCase();
      for (let j = 1; j < mRows.length; j++) {
        if (String(mRows[j][1] || '').trim().toLowerCase() === itemName) {
          let current = String(mRows[j][3] || '').split(';').filter(x => x);
          current = current.filter(c => removeCodes.indexOf(c) === -1);
          addCodes.forEach(c => { if (current.indexOf(c) === -1) current.push(c); });
          await db.setCell(CONFIG.SHEET_MASTER, j + 1, 4, current.join(';'));
          break;
        }
      }
    }
    await db.setCell(CONFIG.SHEET_EDITREQ, rowIdx, 11, action === 'approve' ? 'อนุมัติแล้ว' : 'ปฏิเสธ');
    await db.setCell(CONFIG.SHEET_EDITREQ, rowIdx, 13, nowIso());
    return getEditRequests(pin);
  });
}

/* ============================================================ Admin (master item CRUD) ============================================================ */
async function adminGetItems(pin) { checkAdminPin_(pin); return getMasterItemsWithRow_(); }

async function adminAddItem(pin, item) {
  checkAdminPin_(pin);
  if (!item || !String(item.name || '').trim()) throw new Error('กรุณาระบุชื่อรายการ');
  await ensureSheets_();
  return mutex.runExclusive(async () => {
    await db.appendRow(CONFIG.SHEET_MASTER,
      [item.code || '-', item.name, item.manufacturer || '', (item.productCodes || []).join(';'),
        Number(item.qty) || 0, item.note || '', item.unit || CONFIG.DEFAULT_UNIT]);
    return getMasterItemsWithRow_();
  });
}

async function adminUpdateItem(pin, rowIndex, item) {
  checkAdminPin_(pin);
  if (!item || !String(item.name || '').trim()) throw new Error('กรุณาระบุชื่อรายการ');
  rowIndex = Number(rowIndex);
  if (!rowIndex || rowIndex < 2) throw new Error('ไม่พบรายการนี้');
  await ensureSheets_();
  return mutex.runExclusive(async () => {
    await db.setRange(CONFIG.SHEET_MASTER, rowIndex, 1, [[
      item.code || '-', item.name, item.manufacturer || '', (item.productCodes || []).join(';'),
      Number(item.qty) || 0, item.note || '', item.unit || CONFIG.DEFAULT_UNIT
    ]]);
    return getMasterItemsWithRow_();
  });
}

async function adminDeleteItem(pin, rowIndex) {
  checkAdminPin_(pin);
  rowIndex = Number(rowIndex);
  if (!rowIndex || rowIndex < 2) throw new Error('ไม่พบรายการนี้');
  await ensureSheets_();
  return mutex.runExclusive(async () => {
    await db.deleteRow(CONFIG.SHEET_MASTER, rowIndex);
    return getMasterItemsWithRow_();
  });
}

/* ============================================================ Receiving (ระบบรับเข้าสารเคมี) ============================================================ */

/* สร้าง/ไมเกรตชีท ReceivingLogs ให้มีคอลัมน์ receivedDate, openedDate เสมอ
   (ชีทเก่าที่สร้างไว้ก่อนอัปเดตจะถูกเติมหัวคอลัมน์ให้อัตโนมัติ) */
async function ensureReceivingSheet_() {
  const names = await db.listSheetNames();
  if (names.indexOf(CONFIG.SHEET_RECEIVING) === -1) {
    await db.createSheet(CONFIG.SHEET_RECEIVING,
      ['receiptId', 'receivedAt', 'employeeName', 'itemCode', 'itemName', 'receiveQty', 'remark', 'previousQty', 'newQty', 'receivedDate', 'openedDate', 'expiryDate']);
    return;
  }
  const rows = await db.getDataRange(CONFIG.SHEET_RECEIVING);
  const header = (rows && rows[0]) || [];
  if (header.indexOf('receivedDate') === -1 || header.indexOf('openedDate') === -1) {
    const newHeader = header.slice(0, 9);
    while (newHeader.length < 9) newHeader.push('');
    newHeader[9] = 'receivedDate';
    newHeader[10] = 'openedDate';
    await db.setRange(CONFIG.SHEET_RECEIVING, 1, 1, [newHeader]);
  }
  const rows2 = await db.getDataRange(CONFIG.SHEET_RECEIVING);
  const header2 = (rows2 && rows2[0]) || [];
  if (header2.indexOf('expiryDate') === -1) {
    const newHeader2 = header2.slice(0, 11);
    while (newHeader2.length < 11) newHeader2.push('');
    newHeader2[11] = 'expiryDate';
    await db.setRange(CONFIG.SHEET_RECEIVING, 1, 1, [newHeader2]);
  }
}

async function receiveChemical(pin, payload) {
  checkAdminPin_(pin);
  await ensureSheets_();

  if (!payload || !payload.itemCode || !payload.receiveQty || !payload.employeeName) {
    throw new Error('ข้อมูลการรับเข้าไม่ครบถ้วน');
  }

  return mutex.runExclusive(async () => {
    await ensureReceivingSheet_();

    const qtyToAdd = Number(payload.receiveQty);
    if (isNaN(qtyToAdd) || qtyToAdd <= 0) throw new Error('จำนวนที่รับเข้าต้องมากกว่า 0');

    const mRows = await db.getDataRange(CONFIG.SHEET_MASTER);
    let foundRowIdx = -1;
    let currentQty = 0;
    const targetCode = String(payload.itemCode).trim();
    const itemName = payload.itemName || '';

    for (let i = 1; i < mRows.length; i++) {
      if (String(mRows[i][0] || '').trim() === targetCode) {
        foundRowIdx = i + 1;
        currentQty = Number(mRows[i][4]) || 0;
        break;
      }
    }

    if (foundRowIdx === -1) throw new Error('ไม่พบรหัสสารเคมีนี้ในฐานข้อมูล (MasterItems)');

    const newQty = currentQty + qtyToAdd;
    await db.setCell(CONFIG.SHEET_MASTER, foundRowIdx, 5, newQty);

    const receiptId = 'REC' + Date.now();
    await db.appendRow(CONFIG.SHEET_RECEIVING, [
      receiptId,
      nowIso(),
      payload.employeeName,
      targetCode,
      itemName,
      qtyToAdd,
      payload.remark || '',
      currentQty,
      newQty,
      thaiDate(nowIso()),
      ''
    ]);

    return { success: true, receiptId, newQty };
  });
}

/* ============================================================
   Receiving แบบสแกนบาร์โค้ด (batch): สแกนได้หลายรายการ แล้วบันทึกทีเดียว
   payload = { employeeName, items: [{ itemCode, itemName, receiveQty, remark }] }
   ============================================================ */
async function receiveChemicalBatch(pin, payload) {
  checkAdminPin_(pin);
  await ensureSheets_();

  if (!payload || !payload.employeeName || !payload.items || !payload.items.length) {
    throw new Error('ข้อมูลการรับเข้าไม่ครบถ้วน');
  }

  return mutex.runExclusive(async () => {
    await ensureReceivingSheet_();

    const mRows = await db.getDataRange(CONFIG.SHEET_MASTER);
    const rowIndexByCode = {};
    for (let i = 1; i < mRows.length; i++) {
      const c = String(mRows[i][0] || '').trim();
      if (c) rowIndexByCode[c] = i + 1; // 1-based sheet row
    }

    const now = nowIso();
    const logRows = [];
    const results = [];

    for (let k = 0; k < payload.items.length; k++) {
      const entry = payload.items[k] || {};
      const targetCode = String(entry.itemCode || '').trim();
      const qtyToAdd = Number(entry.receiveQty);

      if (!targetCode || isNaN(qtyToAdd) || qtyToAdd <= 0) {
        results.push({ itemCode: targetCode, success: false, error: 'ข้อมูลรายการไม่ถูกต้อง' });
        continue;
      }
      const rowIdx = rowIndexByCode[targetCode];
      if (!rowIdx) {
        results.push({ itemCode: targetCode, success: false, error: 'ไม่พบรหัสสารเคมีนี้ในฐานข้อมูล (MasterItems)' });
        continue;
      }

      const currentQty = Number(mRows[rowIdx - 1][4]) || 0;
      const newQty = currentQty + qtyToAdd;
      await db.setCell(CONFIG.SHEET_MASTER, rowIdx, 5, newQty);
      mRows[rowIdx - 1][4] = newQty; // sync local copy กันกรณีรหัสซ้ำในชุดเดียวกัน

      const receiptId = 'REC' + Date.now() + '_' + k;
      logRows.push([
        receiptId, now, payload.employeeName, targetCode,
        entry.itemName || '', qtyToAdd, entry.remark || '', currentQty, newQty,
        thaiDate(now), ''
      ]);
      results.push({ itemCode: targetCode, success: true, receiptId, newQty });
    }

    if (logRows.length) await db.appendRows(CONFIG.SHEET_RECEIVING, logRows);
    return { success: true, receivedCount: logRows.length, results };
  });
}

/* ============================================================
   Receiving แบบสแกนบาร์โค้ดหน้างาน (สำหรับพนักงานทั่วไป ไม่ต้องใช้ PIN)
   ใช้คู่กับหน้าจอกล้องสแกนต่อเนื่อง: สแกนแล้วรายการเด้งเข้าระบบอัตโนมัติ
   บันทึกทั้งวันที่รับเข้า (receivedDate) และวันที่เปิดใช้ (openedDate ถ้ามีการเปิดใช้ทันที)
   payload = { employeeName, receivedDate, items: [{ itemCode, itemName, qty, opened, openedDate, remark }] }
   ============================================================ */
async function receiveChemicalScan(payload) {
  await ensureSheets_();

  if (!payload || !String(payload.employeeName || '').trim() || !payload.items || !payload.items.length) {
    throw new Error('ข้อมูลการรับเข้าไม่ครบถ้วน (กรุณาระบุชื่อผู้รับเข้า และสแกนอย่างน้อย 1 รายการ)');
  }

  const employeeName = String(payload.employeeName).trim();
  const batchReceivedDate = String(payload.receivedDate || '').trim() || thaiDate(nowIso());

  return mutex.runExclusive(async () => {
    await ensureReceivingSheet_();

    const mRows = await db.getDataRange(CONFIG.SHEET_MASTER);
    const rowIndexByCode = {};
    for (let i = 1; i < mRows.length; i++) {
      const c = String(mRows[i][0] || '').trim();
      if (c) rowIndexByCode[c] = i + 1; // 1-based sheet row
    }

    const now = nowIso();
    const logRows = [];
    const results = [];

    for (let k = 0; k < payload.items.length; k++) {
      const entry = payload.items[k] || {};
      const targetCode = String(entry.itemCode || '').trim();
      const qtyToAdd = Number(entry.qty);

      if (!targetCode || isNaN(qtyToAdd) || qtyToAdd <= 0) {
        results.push({ itemCode: targetCode, success: false, error: 'ข้อมูลรายการไม่ถูกต้อง' });
        continue;
      }
      const rowIdx = rowIndexByCode[targetCode];
      if (!rowIdx) {
        results.push({ itemCode: targetCode, success: false, error: 'ไม่พบรหัสสารเคมีนี้ในฐานข้อมูล (MasterItems)' });
        continue;
      }

      const currentQty = Number(mRows[rowIdx - 1][4]) || 0;
      const newQty = currentQty + qtyToAdd;
      await db.setCell(CONFIG.SHEET_MASTER, rowIdx, 5, newQty);
      mRows[rowIdx - 1][4] = newQty; // sync local copy กันกรณีรหัสซ้ำในชุดเดียวกัน

      // ถ้าสแกนเจอรหัสล็อตใหม่ (Product code) ที่ยังไม่เคยลงทะเบียนไว้ -> เพิ่มเข้าคอลัมน์ productCodes ของสารตัวนี้
      const newCodes = Array.isArray(entry.newProductCodes) ? entry.newProductCodes.map(c => String(c || '').trim()).filter(Boolean) : [];
      if (newCodes.length) {
        const existingCodesRaw = String(mRows[rowIdx - 1][3] || '').trim();
        const existingCodes = existingCodesRaw ? existingCodesRaw.split(';').map(c => c.trim()).filter(Boolean) : [];
        let changed = false;
        for (const nc of newCodes) {
          if (existingCodes.indexOf(nc) === -1) { existingCodes.push(nc); changed = true; }
        }
        if (changed) {
          const mergedCodes = existingCodes.join(';');
          await db.setCell(CONFIG.SHEET_MASTER, rowIdx, 4, mergedCodes);
          mRows[rowIdx - 1][3] = mergedCodes; // sync local copy กันกรณีรหัสซ้ำในชุดเดียวกัน
        }
      }

      const itemReceivedDate = String(entry.receivedDate || '').trim() || batchReceivedDate;
      const itemOpenedDate = entry.opened ? (String(entry.openedDate || '').trim() || itemReceivedDate) : '';
      const itemExpiryDate = String(entry.expiryDate || '').trim();

      const receiptId = 'REC' + Date.now() + '_' + k;
      logRows.push([
        receiptId, now, employeeName, targetCode,
        entry.itemName || '', qtyToAdd, entry.remark || '', currentQty, newQty,
        itemReceivedDate, itemOpenedDate, itemExpiryDate
      ]);
      results.push({
        itemCode: targetCode, success: true, receiptId, newQty,
        receivedDate: itemReceivedDate, openedDate: itemOpenedDate, expiryDate: itemExpiryDate
      });
    }

    if (logRows.length) await db.appendRows(CONFIG.SHEET_RECEIVING, logRows);
    return { success: true, receivedCount: logRows.length, results };
  });
}

module.exports = {
  getMasterItems, saveDraft, getDraft, submitChecklist,
  getPendingSubmissions, getSubmissionDetail, updateSubmissionItemDetail, approveSubmission,
  getArchiveMonths, getMonthlyRemainingSummary,
  submitEditRequest, requestCodeChange, getEditRequests, resolveEditRequest,
  adminGetItems, adminAddItem, adminUpdateItem, adminDeleteItem,
  receiveChemical, // <-- รับเข้าทีละรายการ (ฟอร์มเดิม)
  receiveChemicalBatch, // <-- รับเข้าแบบสแกนบาร์โค้ดหลายรายการทีเดียว (ฝั่งแอดมิน ต้องใช้ PIN)
  receiveChemicalScan // <-- รับเข้าแบบสแกนกล้องหน้างาน (พนักงานทั่วไป ไม่ต้องใช้ PIN, มีวันที่รับเข้า/วันที่เปิด)
};