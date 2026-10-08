const { google } = require('googleapis');
const stream = require('stream');

function getAuth() {
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
let cachedFolderId = null;

async function getOrCreateFolder() {
  if (cachedFolderId) return cachedFolderId;
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
async function saveSignatureImage(base64Data, filenamePrefix) {
  const folderId = await getOrCreateFolder();
  const raw = base64Data.split(',')[1] || base64Data;
  const buffer = Buffer.from(raw, 'base64');
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const file = await drive.files.create({
    requestBody: {
      name: `${filenamePrefix}.png`,
      parents: [folderId]
    },
    media: { mimeType: 'image/png', body: bufferStream },
    fields: 'id'
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/uc?id=${file.data.id}`;
}

module.exports = { saveSignatureImage };
