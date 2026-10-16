const { google } = require('googleapis');
const stream = require('stream');

/*
  โหมดการทำงาน (เลือกอย่างใดอย่างหนึ่งผ่าน Environment Variables บน Render)

  A) OAuth ของบัญชี Google จริง  -> ใช้โควต้าของเจ้าของบัญชี (ใช้ได้กับ Gmail ธรรมดา)
     GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
     (ถ้ามี DRIVE_FOLDER_ID จะเก็บลงโฟลเดอร์นั้น ไม่มีก็สร้าง/หาโฟลเดอร์ชื่อเดิมให้)

  B) Service Account + Shared Drive  -> ต้องเป็น Google Workspace
     DRIVE_FOLDER_ID = id ของโฟลเดอร์ใน Shared Drive ที่เพิ่ม service account เป็นสมาชิก (Content manager)
*/
const UPLOAD_URL = process.env.DRIVE_UPLOAD_URL || '';
const useOAuth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);

function getAuth() {
  if (useOAuth) {
    const c = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    c.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    return c;
  }
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
  );
}

const auth = getAuth();
const drive = google.drive({ version: 'v3', auth });

const FOLDER_NAME = 'F-WWT-28 ลายเซ็นตรวจนับสารเคมี';
let cachedFolderId = process.env.DRIVE_FOLDER_ID || null;

async function getOrCreateFolder() {
  if (cachedFolderId) return cachedFolderId;
  if (!useOAuth) {
    throw new Error('ยังไม่ได้ตั้งค่า DRIVE_FOLDER_ID (Service Account สร้างโฟลเดอร์ใน My Drive เองไม่ได้)');
  }
  const res = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)'
  });
  if (res.data.files && res.data.files.length) {
    cachedFolderId = res.data.files[0].id;
    return cachedFolderId;
  }
  const created = await drive.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  cachedFolderId = created.data.id;
  return cachedFolderId;
}

/** base64Data may include a data: prefix; filenamePrefix should not include extension */
async function saveViaAppsScript_(base64Data, filenamePrefix) {
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: process.env.DRIVE_UPLOAD_SECRET || '', name: filenamePrefix + '.png', data: base64Data })
  });
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('Apps Script ตอบกลับผิดรูปแบบ: ' + txt.slice(0, 120)); }
  if (!j.url) throw new Error('อัปโหลดลายเซ็นไม่สำเร็จ: ' + (j.error || 'unknown'));
  return j.url;
}

async function saveSignatureImage(base64Data, filenamePrefix) {
  if (UPLOAD_URL) return saveViaAppsScript_(base64Data, filenamePrefix);
  const folderId = await getOrCreateFolder();
  const raw = base64Data.split(',')[1] || base64Data;
  const buffer = Buffer.from(raw, 'base64');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const file = await drive.files.create({
    requestBody: { name: `${filenamePrefix}.png`, parents: [folderId] },
    media: { mimeType: 'image/png', body: bufferStream },
    fields: 'id',
    supportsAllDrives: true
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });

  return `https://drive.google.com/uc?id=${file.data.id}`;
}

module.exports = { saveSignatureImage };
