# F-WWT-28 (Railway edition) — สแกน QR ต่อเนื่องด้วยกล้องมือถือ

ย้ายระบบจาก Google Apps Script มาโฮสต์เองบน Railway (Node.js/Express) เพื่อแก้ปัญหา
กล้อง/GPS ถูกบล็อกจาก iframe sandbox ของ GAS และเพิ่มโหมด **"สแกนต่อเนื่อง"** แบบห้างสรรพสินค้า —
เปิดกล้องค้างไว้ เล็งสแกนทีละขวดได้ต่อเนื่อง ระบบหาเองอัตโนมัติว่าตรงกับสารตัวไหน พร้อมบี๊บ/สั่น/นับให้อัตโนมัติ

## โครงสร้างไฟล์
```
server.js              Express app + REST endpoint /api/rpc
src/sheetsClient.js     wrapper เรียก Google Sheets API v4 (แทน SpreadsheetApp)
src/drive.js            อัปโหลดรูปลายเซ็นเข้า Google Drive (แทน DriveApp)
src/functions.js        พอร์ต business logic ทั้งหมดจาก GS ไฟล์เดิม (1:1)
src/mutex.js            กันเขียนชนกัน (แทน LockService)
public/index.html       หน้าเว็บเดิม + เพิ่มโหมดสแกนต่อเนื่อง
public/gas-compat.js    shim จำลอง google.script.run ให้ยิงเข้า /api/rpc แทน
```

## ขั้นตอนตั้งค่า (ทำครั้งเดียว)

### 1. สร้าง Service Account
1. ไปที่ [Google Cloud Console](https://console.cloud.google.com/) → สร้างโปรเจกต์ (หรือใช้โปรเจกต์เดิม)
2. เปิดใช้งาน **Google Sheets API** และ **Google Drive API**
3. ไปที่ IAM & Admin → Service Accounts → สร้าง Service Account ใหม่
4. สร้างคีย์แบบ JSON (Keys → Add Key → Create new key → JSON) แล้วดาวน์โหลดไฟล์เก็บไว้
5. เปิดไฟล์ JSON คัดลอกค่า `client_email` และ `private_key`

### 2. แชร์สิทธิ์ให้ Service Account
- เปิด Google Sheet เดิม (F-WWT-28) → กด "แชร์" → วางอีเมลของ Service Account (ลงท้าย `.iam.gserviceaccount.com`) → ให้สิทธิ์ **แก้ไขได้ (Editor)**
- ไม่ต้องแชร์ Drive folder ล่วงหน้า ระบบจะสร้างโฟลเดอร์ "F-WWT-28 ลายเซ็นตรวจนับสารเคมี" ให้เองในไดรฟ์ของ Service Account (ถ้าต้องการให้ไฟล์ไปอยู่ใน Shared Drive ของทีมแทน แจ้งได้ จะปรับโค้ดให้)

### 3. ตั้งค่า Environment Variables
คัดลอก `.env.example` เป็น `.env` แล้วกรอก:
```
GOOGLE_SERVICE_ACCOUNT_EMAIL=xxxx@xxxx.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SPREADSHEET_ID=<เอาจาก URL ของชีท>
REVIEWER_PIN=1212312121
ADMIN_PIN=1212312121
```
> `GOOGLE_PRIVATE_KEY` ให้คงเครื่องหมาย `\n` ไว้ในบรรทัดเดียว (ไม่ต้องขึ้นบรรทัดจริง) โค้ดจะแปลงให้เองตอนรัน

### 4. รันทดสอบในเครื่อง
```bash
npm install
npm start
# เปิด http://localhost:3000
```

### 5. Deploy ขึ้น Railway
1. Push โค้ดนี้ขึ้น GitHub repo ใหม่
2. Railway → New Project → Deploy from GitHub repo
3. ใส่ Environment Variables ชุดเดียวกับ `.env` ในหน้า Variables ของ Railway
4. Railway จะ build/deploy อัตโนมัติ (ตรวจพบ `npm start` จาก package.json)
5. ตั้ง Custom Domain (Settings → Networking → Custom Domain) — **จำเป็นมาก** เพื่อให้เป็น top-level origin จริง กล้อง/GPS จึงจะขอ permission ได้ปกติเหมือนที่ทำกับ F-WWT-025

## สิ่งที่ยังทำงานเหมือนเดิมทุกจุด
โค้ด `public/index.html` แทบไม่ได้แก้ logic เดิมเลย — ทุกจุดที่เรียก
`google.script.run.withSuccessHandler(...).withFailureHandler(...).ฟังก์ชัน(...)`
ยังทำงานเหมือนเดิมทุกอย่าง เพราะ `gas-compat.js` จำลอง API ตัวนี้ให้ยิง REST ไปที่ `/api/rpc` แทน
ดังนั้นฟีเจอร์เดิมทั้งหมด (Draft, ส่งใบตรวจนับ, อนุมัติ, Archive รายเดือน, คำขอแก้ไข, Admin CRUD) ใช้งานได้ปกติ

## ฟีเจอร์ใหม่: โหมดสแกนต่อเนื่อง
- ปุ่ม **"📷 สแกนต่อเนื่อง (โหมดยิงเร็ว)"** อยู่เหนือรายการเช็คของ
- เปิดกล้องเต็มจอค้างไว้ ไม่ต้องเลือกรายการก่อน — สแกนเจอ QR ตรงกับสารตัวไหน ระบบหาให้เอง
- บี๊บเสียง + สั่นมือถือ + toast ทุกครั้งที่สแกนสำเร็จ พร้อมนับจำนวนขวดอัตโนมัติ (`นับได้/เอกสาร` เช่น 2/3)
- กันสแกนซ้ำขวดเดียวกัน (เตือนสีเหลือง ไม่นับซ้ำ)
- สแกนไม่พบรหัสในระบบ → เตือนสีแดง ไม่ทำให้แอปค้าง เล็งขวดถัดไปต่อได้เลย
- มีช่องพิมพ์รหัสเองสำรองไว้เผื่อ QR เสียหาย/ลบเลือน
- ค่าที่ scan ได้จะ auto-fill ช่อง "จำนวนนับได้จริง" ให้ แต่ **การกดยืนยันรายการ (checked) ยังคงต้องทำโดยผู้ตรวจนับเอง** เหมือนเดิม เผื่อกรณีจำนวนไม่ตรงเอกสารต้องเลือกเหตุผลก่อน — เป็นการเร่งขั้นตอน ไม่ใช่ตัดขั้นตอนตรวจสอบทิ้ง

## หมายเหตุด้านความปลอดภัย
- Endpoint `/api/rpc` เปิด whitelist เฉพาะฟังก์ชันที่ export จาก `src/functions.js` เท่านั้น เรียกชื่ออื่นจะถูกปฏิเสธทันที
- PIN ยังคงเช็คฝั่ง backend เหมือนเดิม (ไม่ได้ผ่อนสิทธิ์ใดๆ)
- แนะนำเปลี่ยน `REVIEWER_PIN` / `ADMIN_PIN` ให้ไม่ซ้ำกับ PIN สาธารณะอื่น ๆ ก่อนใช้งานจริง
