const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  );
}

const auth = getAuth();
const sheets = google.sheets({ version: 'v4', auth });

/** cache sheetId lookups within a process lifetime, refreshed on demand */
let sheetMetaCache = null;
async function getSpreadsheetMeta(force) {
  if (!sheetMetaCache || force) {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    sheetMetaCache = res.data;
  }
  return sheetMetaCache;
}

async function listSheetNames() {
  const meta = await getSpreadsheetMeta();
  return meta.sheets.map(s => s.properties.title);
}

async function getSheetId(name) {
  const meta = await getSpreadsheetMeta();
  const found = meta.sheets.find(s => s.properties.title === name);
  return found ? found.properties.sheetId : null;
}

async function sheetExists(name) {
  const names = await listSheetNames();
  return names.indexOf(name) > -1;
}

async function createSheet(name, headerRow) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
  });
  sheetMetaCache = null;
  if (headerRow && headerRow.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${name}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] }
    });
  }
}

/** returns 2D array of all values in the sheet (like getDataRange().getValues()) */
async function getDataRange(name) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${name}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  return res.data.values || [];
}

async function appendRow(name, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${name}'`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

async function appendRows(name, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${name}'`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

/** rowIndex is 1-based (row 1 = header), colIndex is 1-based */
function colLetter(colIndex) {
  let s = '';
  while (colIndex > 0) {
    const m = (colIndex - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    colIndex = Math.floor((colIndex - 1) / 26);
  }
  return s;
}

async function setRange(name, rowIndex, colIndex, values2D) {
  const numRows = values2D.length;
  const numCols = values2D[0].length;
  const startCol = colLetter(colIndex);
  const endCol = colLetter(colIndex + numCols - 1);
  const range = `'${name}'!${startCol}${rowIndex}:${endCol}${rowIndex + numRows - 1}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: values2D }
  });
}

async function setCell(name, rowIndex, colIndex, value) {
  await setRange(name, rowIndex, colIndex, [[value]]);
}

async function deleteRow(name, rowIndex /* 1-based */) {
  const sheetId = await getSheetId(name);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,
            endIndex: rowIndex
          }
        }
      }]
    }
  });
}

module.exports = {
  sheets,
  SPREADSHEET_ID,
  listSheetNames,
  sheetExists,
  createSheet,
  getDataRange,
  appendRow,
  appendRows,
  setRange,
  setCell,
  deleteRow,
  colLetter
};
