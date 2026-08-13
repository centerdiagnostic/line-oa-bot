const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const webpush = require('web-push');

// โหลดค่าจาก .env ก่อนทุกอย่าง (ต้องอยู่บนสุดเสมอ)
dotenv.config();

console.log('--- ตรวจสอบค่า .env ---');
console.log('DATABASE_URL       :', process.env.DATABASE_URL ? 'OK' : 'ไม่พบ');
console.log('SUPABASE_URL       :', process.env.SUPABASE_URL ? 'OK' : 'ไม่พบ');
console.log('LINE_CHANNEL_SECRET:', process.env.LINE_CHANNEL_SECRET ? 'OK' : 'ไม่พบ');
console.log('-----------------------');

// ตั้งค่า VAPID Key สำหรับ Push Notification (อ่านจาก .env เท่านั้น ห้าม Hardcode)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️ ยังไม่ได้ตั้งค่า VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY ใน .env — Push Notification จะไม่ทำงาน');
}

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.channelAccessToken
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// หมายเหตุ: ย้ายการตั้งค่า session ไปไว้หลังการสร้าง pool แล้ว (ดูด้านล่าง)

// กำหนดการเชื่อมต่อ Supabase
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Error: ไม่พบค่าการเชื่อมต่อ Supabase กรุณาเพิ่ม SUPABASE_URL และ SUPABASE_KEY ในไฟล์ .env");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// สร้าง Database Wrapper แปลง SQLite เป็น PostgreSQL เพื่อให้โค้ดเก่าทำงานได้ทันที
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ตั้งค่า Session โดยเก็บลง PostgreSQL (ต้องอยู่หลัง pool เท่านั้น ไม่งั้นจะ ReferenceError)
const pgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new pgSession({ pool: pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const db = {
  serialize: (cb) => cb(),
  run: (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.toUpperCase().includes('RETURNING')) {
      pgSql += ' RETURNING *';
    }
    pool.query(pgSql, params || [])
      .then(res => {
        const context = { lastID: res.rows[0]?.id || res.rows[0]?.user_id || 0 };
        if (callback) callback.call(context, null);
      })
      .catch(err => {
        console.error('DB Run Error:', err.message, 'SQL:', pgSql);
        if (callback) callback(err);
      });
  },
  get: (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    pool.query(pgSql, params || [])
      .then(res => callback(null, res.rows[0]))
      .catch(err => {
        console.error('DB Get Error:', err.message, 'SQL:', pgSql);
        if (callback) callback(err, null);
      });
  },
  all: (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    pool.query(pgSql, params || [])
      .then(res => callback(null, res.rows || []))
      .catch(err => {
        console.error('DB All Error:', err.message, 'SQL:', pgSql);
        if (callback) callback(err, []);
      });
  }
};

// สร้างตารางทั้งหมดใน Supabase อัตโนมัติหากยังไม่มี
pool.query(`
  CREATE TABLE IF NOT EXISTS admins (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    picture_url TEXT,
    custom_name TEXT,
    role TEXT DEFAULT 'admin',
    can_broadcast BOOLEAN DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS customers (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    picture_url TEXT,
    status TEXT DEFAULT 'pending',
    last_update TIMESTAMPTZ,
    read_by_name TEXT,
    read_at TIMESTAMPTZ,
    handled_by TEXT,
    internal_note TEXT,
    rating INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    user_id TEXT,
    sender TEXT,
    admin_name TEXT,
    admin_picture TEXT,
    text TEXT,
    timestamp TIMESTAMPTZ,
    read_by_name TEXT,
    admin_id TEXT,
    msg_type TEXT DEFAULT 'text',
    file_url TEXT
  );
  CREATE TABLE IF NOT EXISTS quick_replies (
    id SERIAL PRIMARY KEY,
    label TEXT,
    message TEXT
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id SERIAL PRIMARY KEY,
    user_id TEXT,
    admin_id TEXT,
    score INTEGER,
    timestamp TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS rich_messages (
    id SERIAL PRIMARY KEY,
    name TEXT,
    image_url TEXT,
    action_type TEXT DEFAULT 'link',
    action_value TEXT
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    admin_id TEXT REFERENCES admins(user_id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`).then(() => console.log('✅ Supabase Tables Initialized Successfully'))
  .catch(err => console.error('❌ Table Init Error:', err.message));

function checkAuth(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.redirect('/login');
  }
  // ถ้าเป็น pending ให้เด้งไปหน้าจอรออนุมัติ
  if (req.session.admin.role === 'pending') {
    return res.redirect('/pending');
  }
  next();
}

// เพิ่ม Route หน้าแรกสุด ให้เด้งไปหน้า Dashboard อัตโนมัติ (ถ้ายังไม่ login จะโดน checkAuth เด้งไป /login ต่อเองอีกที)
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

function checkAdminRole(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.role === 'admin') next();
  else res.status(403).send('ไม่มีสิทธิ์เข้าถึงหน้านี้ (เฉพาะ Admin)');
}

// ----------------- Push Notification API -----------------
app.get('/api/push/vapid-public-key', checkAuth, (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', checkAuth, express.json(), async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'ข้อมูล subscription ไม่ครบ' });
    }
    const adminId = req.session.admin.userId;
    await pool.query(
      `INSERT INTO push_subscriptions (admin_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET admin_id = $1, p256dh = $3, auth = $4`,
      [adminId, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err.message);
    res.status(500).json({ error: 'บันทึก subscription ไม่สำเร็จ' });
  }
});

// ฟังก์ชันกลางไว้ยิง Push ไปหาแอดมินทุกคนที่สมัครรับไว้
async function sendPushToAllAdmins(title, body, url) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  try {
    const { rows } = await pool.query('SELECT * FROM push_subscriptions');
    const payload = JSON.stringify({ title, body, url });
    for (const sub of rows) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      webpush.sendNotification(subscription, payload).catch(async (err) => {
        // ถ้า subscription หมดอายุ/ถูกยกเลิกจากฝั่ง browser ให้ลบทิ้งจาก DB
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        } else {
          console.error('Push send error:', err.message);
        }
      });
    }
  } catch (err) {
    console.error('sendPushToAllAdmins error:', err.message);
  }
}

// เพิ่ม Route สำหรับหน้า รออนุมัติ
app.get('/pending', (req, res) => {
  if (!req.session || !req.session.admin) return res.redirect('/login');
  if (req.session.admin.role !== 'pending') return res.redirect('/dashboard');
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head><meta charset="UTF-8"><title>รอการอนุมัติ</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5;margin:0;} .box{background:white;padding:40px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);text-align:center;}</style></head>
    <body>
      <div class="box">
        <h2>⏳ บัญชีของคุณกำลังรอการอนุมัติ</h2>
        <p>คุณไม่มีสิทธิ์เข้าถึง โปรดแจ้ง Admin ให้ปรับสิทธิ์การเข้าถึงของคุณ</p>
        <br><a href="/logout" style="color:red; font-weight:bold; text-decoration:none;">ออกจากระบบ</a>
      </div>
    </body>
    </html>
  `);
});

// ----------------- ระบบ LINE LOGIN -----------------
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>เข้าสู่ระบบแอดมิน</title>
      <style>
        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5; margin: 0; }
        .box { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; }
        .btn { background: #00B900; color: white; border: none; padding: 12px 24px; font-size: 1rem; border-radius: 8px; cursor: pointer; text-decoration: none; display: inline-block; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>🔒 ระบบแอดมิน LINE OA</h2>
        <a class="btn" href="/auth/line">Log in with LINE</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/auth/line', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const redirectUri = encodeURIComponent(`${protocol}://${host}/auth/line/callback`);
  const lineAuthUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${process.env.LINE_LOGIN_CHANNEL_ID}&redirect_uri=${redirectUri}&state=12345&scope=profile%20openid`;
  res.redirect(lineAuthUrl);
});

app.get('/auth/line/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('เกิดข้อผิดพลาด');

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const callbackUrl = `${protocol}://${host}/auth/line/callback`;

  try {
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: callbackUrl,
        client_id: process.env.LINE_LOGIN_CHANNEL_ID,
        client_secret: process.env.LINE_LOGIN_CHANNEL_SECRET
      })
    });
    const tokenData = await tokenRes.json();

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();

    // ตรวจสอบข้อมูลสิทธิ์และชื่อแอดมิน
    const getAdmin = () => new Promise(resolve => db.get(`SELECT custom_name, role, can_broadcast FROM admins WHERE user_id = ?`, [profile.userId], (err, row) => resolve(row)));
    let row = await getAdmin();
    const isFirstAdmin = process.env.FIRST_ADMIN_USER_ID && profile.userId === process.env.FIRST_ADMIN_USER_ID;
    let currentRole = isFirstAdmin ? 'admin' : (row ? (row.role || 'pending') : 'pending');
    let canBroadcast = isFirstAdmin ? true : (row ? Boolean(row.can_broadcast) : false);
    
    if (!row) {
      db.run(
        `INSERT INTO admins (user_id, display_name, picture_url, custom_name, role, can_broadcast) 
         VALUES (?, ?, ?, NULL, ?, ?) 
         ON CONFLICT (user_id) DO UPDATE SET display_name=EXCLUDED.display_name, picture_url=EXCLUDED.picture_url, role=EXCLUDED.role, can_broadcast=EXCLUDED.can_broadcast`,
        [profile.userId, profile.displayName, profile.pictureUrl, currentRole, canBroadcast]
      );
    } else {
      db.run(
        `UPDATE admins SET display_name=?, picture_url=?, role=?, can_broadcast=? WHERE user_id=?`,
        [profile.displayName, profile.pictureUrl, currentRole, canBroadcast, profile.userId]
      );
    }

    req.session.admin = {
      userId: profile.userId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      customName: row ? row.custom_name : null,
      role: currentRole,
      canBroadcast: canBroadcast
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Login failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ----------------- WEBHOOK & APIS -----------------
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) => res.json(result)).catch((err) => {
      console.error(err);
      res.status(500).end();
  });
});

const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// เสิร์ฟไฟล์ PWA ที่วางไว้ root ของโปรเจกต์
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/service-worker.js', (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'service-worker.js'));
});
app.use('/icons', express.static(path.join(__dirname, 'icons')));

app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({extended: true, limit: '50mb'}));

async function handleEvent(event) {
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    if (data.get('action') === 'rate') {
      const score = data.get('score');
      db.get(`SELECT rating, handled_by FROM customers WHERE user_id = ?`, [event.source.userId], async (err, row) => {
        if (row && row.rating !== null) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `คุณได้ให้คะแนนการบริการรอบนี้ไปแล้ว ขอบคุณครับ/ค่ะ 🙏` }]
          });
        } else {
          const now = new Date().toISOString();
          // อัปเดตสถานะใน customers ว่ารอบนี้ประเมินแล้ว เพื่อล็อคไม่ให้กดซ้ำ
          db.run(`UPDATE customers SET rating = ? WHERE user_id = ?`, [score, event.source.userId]);

          // หาเจ้าของคะแนน: ถ้าไม่มีคนกดรับเรื่อง ให้ใช้แอดมินคนล่าสุดที่ตอบลูกค้าคนนี้แทน
          const ownerId = await new Promise(resolve => {
            if (row && row.handled_by) return resolve(row.handled_by);
            db.get(
              `SELECT admin_id FROM messages WHERE user_id = ? AND sender = 'admin' AND admin_id IS NOT NULL ORDER BY timestamp DESC LIMIT 1`,
              [event.source.userId],
              (e, last) => resolve(last ? last.admin_id : null)
            );
          });

          // บันทึกคะแนนลงตาราง ratings เพื่อเก็บประวัติทุกรอบแยกกันโดยไม่ทับของเดิม
          db.run(`INSERT INTO ratings (user_id, admin_id, score, timestamp) VALUES (?, ?, ?, ?)`, [event.source.userId, ownerId, score, now]);
          
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `ขอบคุณสำหรับการประเมิน 🙏` }]
          });
        }
      });
    }
    return Promise.resolve(null);
  }

  if (event.type !== 'message') return Promise.resolve(null);
  if (event.message.type !== 'text' && event.message.type !== 'image' && event.message.type !== 'file') return Promise.resolve(null);
  
  const userId = event.source.userId;
  let text = event.message.type === 'text' ? event.message.text : (event.message.type === 'file' ? '[ส่งไฟล์เอกสาร]' : '[ส่งรูปภาพ/สติกเกอร์]');
  const msgType = event.message.type === 'image' ? 'image' : (event.message.type === 'file' ? 'file' : 'text');
  const now = new Date().toISOString();
  let savedFileUrl = null;

  try {
    // ดึงไฟล์หรือรูปภาพจาก LINE ถ้าลูกค้าส่งมา
    if (msgType === 'image' || msgType === 'file') {
      const stream = await blobClient.getMessageContent(event.message.id);
      const ext = msgType === 'file' ? 'pdf' : 'jpg';
      const filename = msgType === 'file' ? `cust_file_${Date.now()}.${ext}` : `cust_img_${Date.now()}.${ext}`;
      
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      const { data, error } = await supabase.storage.from('uploads').upload(filename, buffer, {
        contentType: ext === 'pdf' ? 'application/pdf' : 'image/jpeg'
      });
      
      if (error) throw error;
      const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(filename);
      
      savedFileUrl = publicUrlData.publicUrl;
      text = msgType === 'file' ? `[ส่งไฟล์: ${event.message.fileName || 'เอกสาร'}]` : '[ส่งรูปภาพ]';
    }

    const profile = await client.getProfile(userId);
    db.run(
      `INSERT INTO customers (user_id, display_name, picture_url, status, last_update) 
       VALUES (?, ?, ?, 'pending', ?) 
       ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, picture_url=excluded.picture_url, status='pending', last_update=excluded.last_update`,
      [userId, profile.displayName, profile.pictureUrl, now]
    );
    db.run(`INSERT INTO messages (user_id, sender, text, timestamp, msg_type, file_url) VALUES (?, 'customer', ?, ?, ?, ?)`, [userId, text, now, msgType, savedFileUrl], function(err) {
      io.emit('newMessage', { id: this.lastID, userId, sender: 'customer', text, timestamp: now, msgType: msgType, fileUrl: savedFileUrl });
      io.emit('updateCustomer', { userId, displayName: profile.displayName, pictureUrl: profile.pictureUrl, status: 'pending', last_update: now });

      // แจ้งเตือน Push ไปหาแอดมินทุกคนเมื่อลูกค้าทักเข้ามาใหม่
      const pushBody = msgType === 'text' ? text : '📎 ส่งไฟล์/รูปภาพมาให้';
      sendPushToAllAdmins(`💬 ${profile.displayName || 'ลูกค้า'}`, pushBody, '/dashboard');
    });
    return Promise.resolve(null);
  } catch (err) { console.error(err); return Promise.resolve(null); }
}

app.get('/dashboard', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// หน้าจัดการสำหรับแอดมิน (ออกแบบใหม่)
app.get('/manage', checkAuth, checkAdminRole, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>จัดการผู้ใช้ (User Management)</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; color: #333; }
        .header { background-color: #00B900; color: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .header h1 { margin: 0; font-size: 1.2rem; }
        .back-btn { color: white; text-decoration: none; background: rgba(0,0,0,0.2); padding: 8px 15px; border-radius: 6px; font-size: 0.9rem; font-weight: bold; transition: background 0.3s; }
        .back-btn:hover { background: rgba(0,0,0,0.3); }
        .container { max-width: 1000px; margin: 40px auto; padding: 0 20px; }
        .card { background: white; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); overflow: hidden; padding: 20px; }
        .card-title { font-size: 1.1rem; font-weight: bold; margin-bottom: 20px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { background-color: #f8f9fa; color: #555; padding: 12px 15px; border-bottom: 2px solid #ddd; font-size: 0.95rem; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; vertical-align: middle; }
        tr:hover { background-color: #fcfcfc; }
        .user-info { display: flex; align-items: center; gap: 12px; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid #ddd; }
        .role-badge { display: inline-block; padding: 5px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; text-transform: uppercase; }
        .role-admin { background-color: #e3f2fd; color: #1976d2; }
        .role-operator { background-color: #f1f8e9; color: #388e3c; }
        .role-pending { background-color: #fff3e0; color: #f57c00; }
        select { padding: 6px 10px; border-radius: 6px; border: 1px solid #ccc; font-family: inherit; font-size: 0.9rem; outline: none; cursor: pointer; }
        select:focus { border-color: #00B900; }

        @media (max-width: 768px) {
          body { overflow-x: hidden; }
          .header { flex-wrap: wrap; row-gap: 8px; padding: 12px 15px; }
          .header h1 { font-size: 1rem; }
          .back-btn { padding: 6px 10px; font-size: 0.8rem; }
          .container { margin: 16px auto; padding: 0 12px; }
          .card { padding: 12px; }
          #usersList { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          table { min-width: 560px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>👥 จัดการผู้ใช้ (User Management)</h1>
        <a href="/dashboard" class="back-btn">❮ กลับไปหน้าแชท</a>
      </div>
      <div class="container">
        <div class="card">
          <div class="card-title">รายชื่อผู้ใช้งานในระบบ</div>
          <div id="usersList">กำลังโหลดข้อมูล...</div>
        </div>
      </div>
      <script>
        fetch('/api/users').then(r=>r.json()).then(users=>{
          let html = '<table><thead><tr><th>ผู้ใช้งาน</th><th>ตำแหน่ง</th><th>สิทธิ์บรอดแคสต์</th><th>จัดการ</th></tr></thead><tbody>';
          if(users.length === 0) {
            html += '<tr><td colspan="4" style="text-align:center; padding: 30px;">ไม่มีข้อมูลผู้ใช้</td></tr>';
          } else {
            users.forEach(u=>{
              const roleClass = 'role-' + u.role;
              let roleText = 'รออนุมัติ';
              if(u.role === 'admin') roleText = 'Admin';
              if(u.role === 'operator') roleText = 'Operator';
              
              const broadcastChecked = u.can_broadcast ? 'checked' : '';
              
              html += '<tr>' +
                '<td>' +
                  '<div class="user-info">' +
                    '<img src="' + u.picture_url + '" class="avatar" alt="Avatar">' +
                    '<div>' +
                      '<div style="font-weight:bold; color:#333;">' + u.display_name + '</div>' +
                      (u.custom_name ? '<div style="font-size:0.8rem; color:#888;">ชื่อแอดมิน: ' + u.custom_name + '</div>' : '') +
                    '</div>' +
                  '</div>' +
                '</td>' +
                '<td>' +
                  '<select id="role_' + u.user_id + '">' +
                    '<option value="pending" ' + (u.role === 'pending' ? 'selected' : '') + '>รออนุมัติ (Pending)</option>' +
                    '<option value="operator" ' + (u.role === 'operator' ? 'selected' : '') + '>Operator</option>' +
                    '<option value="admin" ' + (u.role === 'admin' ? 'selected' : '') + '>Admin</option>' +
                  '</select>' +
                '</td>' +
                '<td>' +
                  '<label style="cursor:pointer; display:flex; align-items:center; gap:5px;">' +
                    '<input type="checkbox" id="bc_' + u.user_id + '" ' + broadcastChecked + ' style="width:16px; height:16px; cursor:pointer;">' +
                    'ส่งบรอดแคสต์ได้' +
                  '</label>' +
                '</td>' +
                '<td><button onclick="updateRole(\\'' + u.user_id + '\\')" style="background:#00B900; color:white; border:none; padding:6px 15px; border-radius:4px; font-weight:bold; cursor:pointer;">บันทึก</button></td>' +
              '</tr>';
            });
          }
          html += '</tbody></table>';
          document.getElementById('usersList').innerHTML = html;
        });
        function updateRole(userId) {
          const role = document.getElementById('role_' + userId).value;
          const canBroadcast = document.getElementById('bc_' + userId).checked ? 1 : 0;
          fetch('/api/users/role', {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId, role, canBroadcast})
          }).then(res=>{
             if(res.ok) {
               alert('✅ อัปเดตสิทธิ์สำเร็จ');
               window.location.reload();
             } else {
               alert('❌ เกิดข้อผิดพลาด');
             }
          });
        }
      </script>
    </body>
    </html>
  `);
});

// หน้าสรุปข้อมูล (ออกแบบใหม่)
app.get('/summary', checkAuth, checkAdminRole, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>หน้าสรุปข้อมูล (Dashboard Summary)</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; color: #333; }
        .header { background-color: #00B900; color: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .header h1 { margin: 0; font-size: 1.2rem; }
        .back-btn { color: white; text-decoration: none; background: rgba(0,0,0,0.2); padding: 8px 15px; border-radius: 6px; font-size: 0.9rem; font-weight: bold; transition: background 0.3s; }
        .back-btn:hover { background: rgba(0,0,0,0.3); }
        .container { max-width: 1000px; margin: 40px auto; padding: 0 20px; }
        .filter-bar { background: white; padding: 15px 25px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); margin-bottom: 20px; display: flex; align-items: center; gap: 15px; }
        .filter-bar input[type="date"] { padding: 8px 15px; border: 1px solid #ddd; border-radius: 6px; font-family: inherit; font-size: 1rem; outline: none; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .card { background: white; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; position: relative; }
        .card.clickable { cursor: pointer; transition: transform 0.2s; border: 1px solid transparent; }
        .card.clickable:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(0,0,0,0.1); border-color: #00B900; }
        .card-icon { font-size: 2.2rem; margin-bottom: 10px; }
        .card-value { font-size: 1.8rem; font-weight: bold; color: #00B900; margin-bottom: 5px; }
        .card-label { font-size: 0.85rem; color: #666; font-weight: 500; }
        .info-panel { background: white; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); padding: 30px; margin-bottom: 30px; }
        .info-panel h2 { margin-top: 0; color: #444; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 20px; font-size: 1.1rem; }
        .chart-container { max-width: 450px; margin: 0 auto 20px auto; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { background-color: #f8f9fa; color: #555; padding: 12px 15px; border-bottom: 2px solid #ddd; font-size: 0.95rem; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; }
        
        /* Modal Styles */
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 25px; border-radius: 10px; width: 400px; max-height: 80vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .modal-header h3 { margin: 0; color: #333; font-size: 1.1rem; }
        .close-btn { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #999; }
        .admin-list-item { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
        .admin-list-item:last-child { border-bottom: none; }
        .admin-role { font-size: 0.75rem; padding: 4px 10px; border-radius: 12px; font-weight: bold; }
        .role-admin { background: #e3f2fd; color: #1976d2; }
        .role-op { background: #f1f8e9; color: #388e3c; }

        @media (max-width: 768px) {
          body { overflow-x: hidden; }
          .header { flex-wrap: wrap; row-gap: 8px; padding: 12px 15px; }
          .header h1 { font-size: 1rem; }
          .back-btn { padding: 6px 10px; font-size: 0.8rem; }
          .container { margin: 16px auto; padding: 0 12px; }
          .filter-bar { flex-wrap: wrap; padding: 12px 15px; gap: 10px; }
          .info-panel { padding: 15px; }
          .modal-content { width: 90vw; max-width: 360px; padding: 18px; }
          .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          table { min-width: 480px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📊 หน้าสรุปข้อมูล (Dashboard Summary)</h1>
        <a href="/dashboard" class="back-btn">❮ กลับไปหน้าแชท</a>
      </div>
      <div class="container">
        
        <div class="filter-bar">
          <label style="font-weight: bold; color: #555;">📅 เลือกวันที่:</label>
          <input type="date" id="dateFilter" onchange="loadSummary()">
          <button onclick="document.getElementById('dateFilter').value=''; loadSummary();" style="padding: 8px 15px; background: #f0f0f0; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; color: #333; font-weight: bold;">ดูยอดรวมทั้งหมด</button>
          <button onclick="exportToExcel()" style="padding: 8px 15px; background: #217346; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; margin-left: auto; display: flex; align-items: center; gap: 5px;">📊 ดาวน์โหลด Excel</button>
        </div>

        <div class="grid">
          <div class="card clickable" onclick="openAdminModal()">
            <div class="card-icon">👥</div>
            <div class="card-value" id="totalAdmins">-</div>
            <div class="card-label">แอดมินทั้งหมด (คน)</div>
          </div>
          <div class="card">
            <div class="card-icon">📥</div>
            <div class="card-value" id="totalChats">-</div>
            <div class="card-label">คนทักแชทมา (คน)</div>
          </div>
          <div class="card">
            <div class="card-icon">💬</div>
            <div class="card-value" id="answeredChats">-</div>
            <div class="card-label">การตอบกลับ (คน)</div>
          </div>
          <div class="card">
            <div class="card-icon">⏳</div>
            <div class="card-value" id="pendingChats">-</div>
            <div class="card-label">ค้างตอบ (คน)</div>
          </div>
          <div class="card">
            <div class="card-icon">⚡</div>
            <div class="card-value" id="avgResponseTime">-</div>
            <div class="card-label">เวลาตอบเฉลี่ย (นาที)</div>
          </div>
        </div>
        
        <div class="info-panel">
          <h2>สัดส่วนและการจัดอันดับการตอบแชท</h2>
          
          <div class="chart-container">
            <canvas id="summaryChart"></canvas>
          </div>
          
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ชื่อแอดมินที่ใช้ตอบ</th>
                  <th>จำนวนข้อความที่ตอบ</th>
                  <th>คะแนนรีวิวเฉลี่ย</th>
                </tr>
              </thead>
              <tbody id="adminStatsBody">
                <tr><td colspan="3" style="text-align:center;">กำลังโหลด...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Modal สำหรับแสดงรายชื่อ Admin -->
      <div class="modal-overlay" id="adminModal">
        <div class="modal-content">
          <div class="modal-header">
            <h3>รายชื่อแอดมินและโอเปอเรเตอร์</h3>
            <button class="close-btn" onclick="closeAdminModal()">&times;</button>
          </div>
          <div id="adminListBody"></div>
        </div>
      </div>

      <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>
      <script>
        let adminDataList = [];
        let currentSummaryData = null;
        let chartInstance = null;

        function openAdminModal() {
          document.getElementById('adminModal').style.display = 'flex';
          const listBody = document.getElementById('adminListBody');
          listBody.innerHTML = '';
          
          if (adminDataList.length === 0) {
            listBody.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">ไม่มีข้อมูล</div>';
            return;
          }
          
          adminDataList.forEach(admin => {
            const name = admin.custom_name ? admin.display_name + ' (' + admin.custom_name + ')' : admin.display_name;
            const isAdm = (admin.role === 'admin');
            const roleStr = isAdm ? 'Admin' : 'Operator';
            const roleClass = isAdm ? 'role-admin' : 'role-op';
            
            listBody.innerHTML += '<div class="admin-list-item">' +
              '<div style="font-weight: 500;">' + name + '</div>' +
              '<div class="admin-role ' + roleClass + '">' + roleStr + '</div>' +
            '</div>';
          });
        }

        function closeAdminModal() {
          document.getElementById('adminModal').style.display = 'none';
        }

        function loadSummary() {
          const dateVal = document.getElementById('dateFilter').value;
          const query = dateVal ? '?date=' + dateVal : '';
          
          fetch('/api/summary_data' + query)
            .then(r => r.json())
            .then(data => {
              currentSummaryData = data;
              // 1. อัปเดตรายชื่อแอดมินและป้ายสถิติ
              adminDataList = data.admins || [];
              document.getElementById('totalAdmins').innerText = adminDataList.length;
              document.getElementById('totalChats').innerText = data.total_customers || 0;
              document.getElementById('answeredChats').innerText = data.answered_customers || 0;
              document.getElementById('pendingChats').innerText = data.pending_customers || 0;
              
              const avgTime = data.avg_response_minutes ? parseFloat(data.avg_response_minutes).toFixed(1) : 0;
              document.getElementById('avgResponseTime').innerText = avgTime;
              
              // 2. อัปเดตตารางสรุปรายคน
              const tbody = document.getElementById('adminStatsBody');
              tbody.innerHTML = '';
              
              const chartLabels = [];
              const chartValues = [];
              const chartColors = ['#00B900', '#2196F3', '#FF9800', '#F44336', '#9C27B0', '#00BCD4', '#607D8B'];
              
              if (data.admin_stats && data.admin_stats.length > 0) {
                data.admin_stats.forEach(stat => {
                  const name = stat.admin_name || 'ไม่ได้ระบุชื่อ';
                  const rating = stat.avg_rating ? parseFloat(stat.avg_rating).toFixed(1) + ' ⭐' : 'ยังไม่มีคะแนน';
                  chartLabels.push(name);
                  chartValues.push(stat.reply_count);
                  tbody.innerHTML += '<tr><td>' + name + '</td><td style="font-weight:bold; color:#00B900; font-size: 1.1rem;">' + stat.reply_count + '</td><td style="font-weight:bold; color:#ffb300;">' + rating + '</td></tr>';
                });
              } else {
                chartLabels.push('ไม่มีข้อมูล');
                chartValues.push(1);
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#666; padding: 20px;">ไม่มีข้อมูลการตอบกลับในวันที่เลือก</td></tr>';
              }
              
              // 3. วาดกราฟ
              if (chartInstance) {
                chartInstance.destroy();
              }
              
              const ctx = document.getElementById('summaryChart').getContext('2d');
              chartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                  labels: chartLabels,
                  datasets: [{
                    data: chartValues,
                    backgroundColor: chartColors,
                    borderWidth: 1
                  }]
                },
                options: {
                  responsive: true,
                  plugins: {
                    legend: { position: 'bottom' }
                  }
                }
              });
              
            })
            .catch(err => {
              console.error(err);
              alert('เกิดข้อผิดพลาดในการโหลดข้อมูล');
            });
        }

        function exportToExcel() {
          if (!currentSummaryData) return alert('ไม่มีข้อมูลสำหรับดาวน์โหลด');
          
          const dateVal = document.getElementById('dateFilter').value || 'ทั้งหมด';
          
          const avgTime = currentSummaryData.avg_response_minutes ? parseFloat(currentSummaryData.avg_response_minutes).toFixed(1) : 0;
          
          // สร้างข้อมูลแผ่นที่ 1: ภาพรวม
          const overviewData = [
            ['สรุปข้อมูลประจำวันที่', dateVal],
            ['แอดมินทั้งหมด (คน)', adminDataList.length],
            ['คนทักแชทมา (คน)', currentSummaryData.total_customers || 0],
            ['การตอบกลับ (คน)', currentSummaryData.answered_customers || 0],
            ['ค้างตอบปัจจุบัน (คน)', currentSummaryData.pending_customers || 0],
            ['เวลาตอบเฉลี่ย (นาที)', avgTime]
          ];
          
          // สร้างข้อมูลแผ่นที่ 2: สถิติรายคน
          const statsData = [['ชื่อแอดมินที่ใช้ตอบ', 'จำนวนข้อความที่ตอบ', 'คะแนนเฉลี่ย (ดาว)']];
          if (currentSummaryData.admin_stats && currentSummaryData.admin_stats.length > 0) {
            currentSummaryData.admin_stats.forEach(stat => {
              const rating = stat.avg_rating ? parseFloat(stat.avg_rating).toFixed(1) : 'ไม่มีคะแนน';
              statsData.push([stat.admin_name || 'ไม่ได้ระบุชื่อ', stat.reply_count, rating]);
            });
          } else {
            statsData.push(['ไม่มีข้อมูลการตอบกลับ', 0, '-']);
          }

          const wb = XLSX.utils.book_new();
          
          const wsOverview = XLSX.utils.aoa_to_sheet(overviewData);
          XLSX.utils.book_append_sheet(wb, wsOverview, "ภาพรวม (Overview)");
          
          const wsStats = XLSX.utils.aoa_to_sheet(statsData);
          XLSX.utils.book_append_sheet(wb, wsStats, "สถิติรายบุคคล (Stats)");
          
          const fileName = dateVal === 'ทั้งหมด' ? 'Chat_Summary_All.xlsx' : 'Chat_Summary_' + dateVal + '.xlsx';
          XLSX.writeFile(wb, fileName);
        }

        // ตั้งค่าวันที่ปัจจุบันเมื่อเปิดหน้า
        window.onload = () => {
          const today = new Date();
          const yyyy = today.getFullYear();
          const mm = String(today.getMonth() + 1).padStart(2, '0');
          const dd = String(today.getDate()).padStart(2, '0');
          document.getElementById('dateFilter').value = yyyy + '-' + mm + '-' + dd;
          loadSummary(); // โหลดข้อมูลทันที
        };
      </script>
    </body>
    </html>
  `);
});

// API สำหรับดึงข้อมูลสรุป Dashboard
app.get('/api/summary_data', checkAuth, checkAdminRole, (req, res) => {
  const date = req.query.date; // รูปแบบ YYYY-MM-DD
  let dateConditionMsg = "";
  let dateParamMsg = [];
  
  if (date) {
    dateConditionMsg = " AND date(timestamp AT TIME ZONE 'Asia/Bangkok') = ?";
    dateParamMsg.push(date);
  }

  db.serialize(() => {
    let data = {};
    
    // 1. แอดมินและโอเปอเรเตอร์ทั้งหมดที่อนุมัติแล้ว
    db.all("SELECT display_name, custom_name, role FROM admins WHERE role IN ('admin', 'operator')", [], (err, admins) => {
      data.admins = admins || [];
      
      // 2. สถิติคนทักแชทมา (จำนวนลูกค้าที่ไม่ซ้ำกันที่ทักมาในวันนั้น)
      db.get("SELECT COUNT(DISTINCT user_id) as total_customers FROM messages WHERE sender = 'customer'" + dateConditionMsg, dateParamMsg, (err, rowCust) => {
        data.total_customers = rowCust ? rowCust.total_customers : 0;
        
        // 3. สถิติการตอบกลับ (จำนวนลูกค้าที่ไม่ซ้ำกันที่แอดมินตอบในวันนั้น)
        db.get("SELECT COUNT(DISTINCT user_id) as answered_customers FROM messages WHERE sender = 'admin'" + dateConditionMsg, dateParamMsg, (err, rowAns) => {
          data.answered_customers = rowAns ? rowAns.answered_customers : 0;
          
          // 4. สถิติค้างตอบปัจจุบัน (ยอด Real-time ไม่ต้องอิงวันที่)
          db.get("SELECT COUNT(*) as pending_customers FROM customers WHERE status = 'pending'", [], (err, rowPend) => {
            data.pending_customers = rowPend ? rowPend.pending_customers : 0;
            
            // 5. สถิติเวลาตอบเฉลี่ย (นาที) คำนวณจากระยะเวลาที่ลูกค้าทักมาจนแอดมินตอบ
            const avgTimeQuery = `
              SELECT AVG(
                EXTRACT(EPOCH FROM (m_admin.timestamp::timestamp - 
                  (SELECT MAX(timestamp)::timestamp FROM messages m_cust 
                   WHERE m_cust.user_id = m_admin.user_id 
                     AND m_cust.sender = 'customer' 
                     AND m_cust.timestamp < m_admin.timestamp)
                )) / 60
              ) as avg_response_minutes
              FROM messages m_admin
              WHERE m_admin.sender = 'admin'` + dateConditionMsg.replace('timestamp', 'm_admin.timestamp');
              
            db.get(avgTimeQuery, dateParamMsg, (err, rowAvg) => {
              data.avg_response_minutes = rowAvg ? rowAvg.avg_response_minutes : 0;

              // 6. สถิติรายแอดมิน (อิงตาม admin_id เพื่อรวมยอดทุกชื่อของคนเดียวกัน พร้อมคะแนนรีวิวเฉลี่ย)
              const statsQuery = `
                SELECT 
                  COALESCE(a.custom_name, a.display_name, m.admin_name) as admin_name, 
                  COUNT(m.id) as reply_count,
                  (SELECT AVG(r.score) FROM ratings r WHERE r.admin_id = m.admin_id
                    ${date ? "AND date(r.timestamp) = '" + date.replace(/[^0-9-]/g, '') + "'" : ""}) as avg_rating
                FROM messages m 
                LEFT JOIN admins a ON m.admin_id = a.user_id 
                WHERE m.sender = 'admin' ` + dateConditionMsg.replace('timestamp', 'm.timestamp') + `
                GROUP BY m.admin_id, m.admin_name, a.custom_name, a.display_name
                ORDER BY reply_count DESC`;
              db.all(statsQuery, dateParamMsg, (err, adminStats) => {
                data.admin_stats = adminStats || [];
                res.json(data);
              });
            });
          });
        });
      });
    });
  });
});

// หน้าจัดการควิกแชท (Quick Replies)
app.get('/manage_qr', checkAuth, checkAdminRole, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>จัดการข้อความตอบด่วน (Quick Replies)</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; color: #333; }
        .header { background-color: #00B900; color: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .header h1 { margin: 0; font-size: 1.2rem; }
        .back-btn { color: white; text-decoration: none; background: rgba(0,0,0,0.2); padding: 8px 15px; border-radius: 6px; font-size: 0.9rem; font-weight: bold; transition: background 0.3s; }
        .back-btn:hover { background: rgba(0,0,0,0.3); }
        .container { max-width: 1000px; margin: 40px auto; padding: 0 20px; }
        .card { background: white; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); padding: 20px; margin-bottom: 20px; }
        .card-title { font-size: 1.1rem; font-weight: bold; margin-bottom: 20px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: bold; font-size: 0.9rem; }
        .form-control { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-family: inherit; font-size: 0.95rem; box-sizing: border-box; }
        .btn-add { background: #00B900; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 0.95rem; }
        .btn-cancel { background: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 0.95rem; margin-left: 10px; display: none; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { background-color: #f8f9fa; color: #555; padding: 12px 15px; border-bottom: 2px solid #ddd; font-size: 0.95rem; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; vertical-align: top; }
        .btn-delete { background: #dc3545; color: white; border: none; padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; font-weight: bold; }
        .btn-edit { background: #ffc107; color: #333; border: none; padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; font-weight: bold; margin-right: 5px; }

        @media (max-width: 768px) {
          body { overflow-x: hidden; }
          .header { flex-wrap: wrap; row-gap: 8px; padding: 12px 15px; }
          .header h1 { font-size: 1rem; }
          .back-btn { padding: 6px 10px; font-size: 0.8rem; }
          .container { margin: 16px auto; padding: 0 12px; }
          .card { padding: 12px; }
          .btn-add, .btn-cancel { width: 100%; margin: 5px 0 0 0; box-sizing: border-box; }
          #qrList { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          table { min-width: 480px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>⚡ จัดการข้อความตอบด่วน (Quick Replies)</h1>
        <a href="/dashboard" class="back-btn">❮ กลับไปหน้าแชท</a>
      </div>
      <div class="container">
        <div class="card">
          <div class="card-title" id="formTitle">เพิ่มข้อความตอบด่วนใหม่</div>
          <div class="form-group">
            <label>ป้ายกำกับปุ่ม (Label):</label>
            <input type="text" id="qrLabel" class="form-control" placeholder="เช่น ทักทาย, เลขบัญชี, ขอบคุณ">
          </div>
          <div class="form-group">
            <label>ข้อความที่จะส่ง (Message):</label>
            <textarea id="qrMessage" class="form-control" rows="3" placeholder="ข้อความเต็มๆ ที่ต้องการส่งให้ลูกค้า..."></textarea>
          </div>
          <button class="btn-add" id="submitBtn" onclick="saveQR()">+ เพิ่มข้อความ</button>
          <button class="btn-cancel" id="cancelBtn" onclick="cancelEdit()">ยกเลิกการแก้ไข</button>
        </div>
        
        <div class="card">
          <div class="card-title">รายการข้อความตอบด่วนปัจจุบัน</div>
          <div id="qrList">กำลังโหลด...</div>
        </div>
      </div>
      <script>
        let editingId = null;

        function loadQR() {
          fetch('/api/quick_replies').then(r=>r.json()).then(data => {
            let html = '<table><thead><tr><th>ป้ายกำกับปุ่ม</th><th>ข้อความ</th><th>จัดการ</th></tr></thead><tbody>';
            if(data.length === 0) {
              html += '<tr><td colspan="3" style="text-align:center; padding:20px;">ยังไม่มีข้อความตอบด่วน</td></tr>';
            } else {
              data.forEach(qr => {
                const safeLabel = qr.label.replace(/'/g, "\\\\'");
                const safeMessage = qr.message.replace(/'/g, "\\\\'");
                html += '<tr>' +
                  '<td style="font-weight:bold;">' + qr.label + '</td>' +
                  '<td>' + qr.message + '</td>' +
                  '<td style="white-space: nowrap;">' +
                    '<button class="btn-edit" onclick="editQR(' + qr.id + ', \\'' + safeLabel + '\\', \\'' + safeMessage + '\\')">แก้ไข</button>' +
                    '<button class="btn-delete" onclick="deleteQR(' + qr.id + ')">ลบ</button>' +
                  '</td>' +
                '</tr>';
              });
            }
            html += '</tbody></table>';
            document.getElementById('qrList').innerHTML = html;
          });
        }
        
        function editQR(id, label, message) {
          editingId = id;
          document.getElementById('qrLabel').value = label;
          document.getElementById('qrMessage').value = message;
          document.getElementById('formTitle').innerText = 'แก้ไขข้อความตอบด่วน';
          document.getElementById('submitBtn').innerText = '💾 บันทึกการแก้ไข';
          document.getElementById('cancelBtn').style.display = 'inline-block';
          window.scrollTo(0, 0);
        }

        function cancelEdit() {
          editingId = null;
          document.getElementById('qrLabel').value = '';
          document.getElementById('qrMessage').value = '';
          document.getElementById('formTitle').innerText = 'เพิ่มข้อความตอบด่วนใหม่';
          document.getElementById('submitBtn').innerText = '+ เพิ่มข้อความ';
          document.getElementById('cancelBtn').style.display = 'none';
        }
        
        function saveQR() {
          const label = document.getElementById('qrLabel').value.trim();
          const message = document.getElementById('qrMessage').value.trim();
          if(!label || !message) return alert('กรุณากรอกข้อมูลให้ครบถ้วน');
          
          const url = editingId ? '/api/quick_replies/' + editingId : '/api/quick_replies';
          const method = editingId ? 'PUT' : 'POST';

          fetch(url, {
            method: method,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ label, message })
          }).then(res => res.json()).then(res => {
            if(res.success) {
              cancelEdit();
              loadQR();
            } else alert('เกิดข้อผิดพลาด');
          });
        }
        
        function deleteQR(id) {
          if(!confirm('ยืนยันการลบข้อความตอบด่วนนี้?')) return;
          fetch('/api/quick_replies/' + id, { method: 'DELETE' })
            .then(res => res.json()).then(res => {
              if(res.success) {
                if(editingId === id) cancelEdit();
                loadQR();
              }
              else alert('เกิดข้อผิดพลาด');
            });
        }
        
        window.onload = loadQR;
      </script>
    </body>
    </html>
  `);
});

// หน้าบรอดแคสต์
function checkBroadcastRole(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.canBroadcast) next();
  else res.status(403).send('ไม่มีสิทธิ์เข้าถึงหน้านี้ (เฉพาะผู้มีสิทธิ์บรอดแคสต์)');
}


// หน้าจัดการริชเมสเสจ (Rich Message)
app.get('/manage_rich_msg', checkAuth, checkBroadcastRole, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>จัดการริชเมสเสจ (Rich Messages)</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; color: #333; }
        .header { background-color: #00B900; color: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .header h1 { margin: 0; font-size: 1.2rem; }
        .back-btn { color: white; text-decoration: none; background: rgba(0,0,0,0.2); padding: 8px 15px; border-radius: 6px; font-size: 0.9rem; font-weight: bold; transition: background 0.3s; }
        .back-btn:hover { background: rgba(0,0,0,0.3); }
        .container { max-width: 1000px; margin: 40px auto; padding: 0 20px; }
        .card { background: white; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); padding: 20px; margin-bottom: 20px; }
        .card-title { font-size: 1.1rem; font-weight: bold; margin-bottom: 20px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: bold; font-size: 0.9rem; }
        .form-control { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-family: inherit; font-size: 0.95rem; box-sizing: border-box; }
        .btn-add { background: #00B900; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 0.95rem; }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { background-color: #f8f9fa; color: #555; padding: 12px 15px; border-bottom: 2px solid #ddd; font-size: 0.95rem; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; vertical-align: top; }
        .btn-delete { background: #dc3545; color: white; border: none; padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; font-weight: bold; }
        .preview-img { max-width: 150px; border-radius: 8px; border: 1px solid #ddd; }

        @media (max-width: 768px) {
          body { overflow-x: hidden; }
          .header { flex-wrap: wrap; row-gap: 8px; padding: 12px 15px; }
          .header h1 { font-size: 1rem; }
          .back-btn { padding: 6px 10px; font-size: 0.8rem; }
          .container { margin: 16px auto; padding: 0 12px; }
          .card { padding: 12px; }
          .btn-add { width: 100%; }
          #rmList { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          table { min-width: 480px; }
          .preview-img { max-width: 90px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎇 จัดการริชเมสเสจ (Rich Messages)</h1>
        <a href="/dashboard" class="back-btn">❮ กลับไปหน้าแชท</a>
      </div>
      <div class="container">
        <div class="card">
          <div class="card-title">สร้างริชเมสเสจใหม่</div>
          <div class="form-group">
            <label>ชื่อริชเมสเสจ:</label>
            <input type="text" id="rmName" class="form-control" placeholder="ตั้งชื่อเพื่อให้จำง่าย (เช่น โปรโมชั่นเดือน 10)...">
          </div>
          <div class="form-group">
            <label>รูปร่างสี่เหลี่ยมจัตุรัส (อัตราส่วน 1:1 แนะนำ 1040x1040 px):</label>
            <input type="file" id="rmImage" class="form-control" accept="image/*">
          </div>
          <div class="form-group">
            <label>ลิงก์ปลายทาง (เมื่อลูกค้ากดรูป):</label>
            <input type="text" id="rmLink" class="form-control" placeholder="https://...">
          </div>
          <button class="btn-add" onclick="saveRichMessage()">+ บันทึกริชเมสเสจ</button>
        </div>
        
        <div class="card">
          <div class="card-title">ริชเมสเสจที่มีในระบบ</div>
          <div id="rmList">กำลังโหลด...</div>
        </div>
      </div>
      <script>
        function loadRichMessages() {
          fetch('/api/rich_messages').then(r=>r.json()).then(data => {
            let html = '<table><thead><tr><th>รูปภาพ</th><th>ชื่อ</th><th>ลิงก์ปลายทาง</th><th>จัดการ</th></tr></thead><tbody>';
            if(data.length === 0) {
              html += '<tr><td colspan="4" style="text-align:center; padding:20px;">ยังไม่มีริชเมสเสจ</td></tr>';
            } else {
              data.forEach(rm => {
                html += '<tr>' +
                  '<td><img src="' + rm.image_url + '" class="preview-img"></td>' +
                  '<td style="font-weight:bold;">' + rm.name + '</td>' +
                  '<td><a href="' + rm.action_value + '" target="_blank">' + rm.action_value + '</a></td>' +
                  '<td><button class="btn-delete" onclick="deleteRichMessage(' + rm.id + ')">ลบ</button></td>' +
                '</tr>';
              });
            }
            html += '</tbody></table>';
            document.getElementById('rmList').innerHTML = html;
          });
        }
        
        function saveRichMessage() {
          const name = document.getElementById('rmName').value.trim();
          const link = document.getElementById('rmLink').value.trim();
          const fileInput = document.getElementById('rmImage');
          
          if(!name || !link || fileInput.files.length === 0) return alert('กรุณากรอกข้อมูลและเลือกรูปภาพให้ครบถ้วน');
          
          const reader = new FileReader();
          reader.onload = function(e) {
            fetch('/api/rich_messages', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ name, action_value: link, imageBase64: e.target.result })
            }).then(res => res.json()).then(res => {
              if(res.success) {
                document.getElementById('rmName').value = '';
                document.getElementById('rmLink').value = '';
                fileInput.value = '';
                loadRichMessages();
                alert('✅ บันทึกสำเร็จ');
              } else alert('❌ เกิดข้อผิดพลาด');
            });
          };
          reader.readAsDataURL(fileInput.files[0]);
        }
        
        function deleteRichMessage(id) {
          if(!confirm('ยืนยันการลบริชเมสเสจนี้?')) return;
          fetch('/api/rich_messages/' + id, { method: 'DELETE' })
            .then(res => res.json()).then(res => {
              if(res.success) loadRichMessages();
              else alert('❌ เกิดข้อผิดพลาด');
            });
        }
        
        window.onload = loadRichMessages;
      </script>
    </body>
    </html>
  `);
});

app.get('/api/rich_messages', checkAuth, checkBroadcastRole, (req, res) => {
  db.all("SELECT * FROM rich_messages ORDER BY id DESC", [], (err, rows) => res.json(rows || []));
});

app.post('/api/rich_messages', checkAuth, checkBroadcastRole, async (req, res) => {
  const { name, action_value, imageBase64 } = req.body;
  
  if (!imageBase64) return res.status(400).json({ error: 'Image required' });
  
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
  let ext = 'jpg';
  if (imageBase64.indexOf(';base64') > -1) {
    ext = imageBase64.substring("data:image/".length, imageBase64.indexOf(";base64"));
  }
  
  const filename = `rm_${Date.now()}.${ext}`;
  const buffer = Buffer.from(base64Data, 'base64');
  
  await supabase.storage.from('uploads').upload(filename, buffer, {
    contentType: `image/${ext}`
  });
  
  const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(filename);
  const secureUrl = publicUrlData.publicUrl;
  
  db.run("INSERT INTO rich_messages (name, image_url, action_type, action_value) VALUES (?, ?, 'link', ?)", [name, secureUrl, action_value], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/rich_messages/:id', checkAuth, checkBroadcastRole, (req, res) => {
  db.run("DELETE FROM rich_messages WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// API สำหรับ Quick Replies
app.get('/api/quick_replies', checkAuth, (req, res) => {
  db.all("SELECT * FROM quick_replies ORDER BY id ASC", [], (err, rows) => res.json(rows || []));
});

app.post('/api/quick_replies', checkAuth, checkAdminRole, (req, res) => {
  const { label, message } = req.body;
  db.run("INSERT INTO quick_replies (label, message) VALUES (?, ?)", [label, message], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/quick_replies/:id', checkAuth, checkAdminRole, (req, res) => {
  const { label, message } = req.body;
  db.run("UPDATE quick_replies SET label = ?, message = ? WHERE id = ?", [label, message, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/quick_replies/:id', checkAuth, checkAdminRole, (req, res) => {
  db.run("DELETE FROM quick_replies WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/users', checkAuth, checkAdminRole, (req, res) => {
  db.all("SELECT user_id, display_name, picture_url, custom_name, role, can_broadcast FROM admins", [], (err, rows) => res.json(rows || []));
});

app.post('/api/users/role', checkAuth, checkAdminRole, (req, res) => {
  const { userId, role, canBroadcast } = req.body;
  const isBroadcast = canBroadcast === 1 || canBroadcast === true || canBroadcast === '1';
  db.run("UPDATE admins SET role = ?, can_broadcast = ? WHERE user_id = ?", [role, isBroadcast, userId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/me', checkAuth, (req, res) => {
  db.get(`SELECT role, can_broadcast, custom_name FROM admins WHERE user_id = ?`, [req.session.admin.userId], (err, row) => {
    if (row) {
      req.session.admin.role = row.role;
      req.session.admin.canBroadcast = row.can_broadcast;
      req.session.admin.customName = row.custom_name;
    }
    res.json(req.session.admin);
  });
});

// API สำหรับบันทึกชื่อแอดมินใหม่
app.post('/api/me/name', checkAuth, (req, res) => {
  const { customName } = req.body;
  req.session.admin.customName = customName;
  db.run(`UPDATE admins SET custom_name = ? WHERE user_id = ?`, [customName, req.session.admin.userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, customName });
  });
});

app.get('/api/customers', checkAuth, (req, res) => {
  db.all(`SELECT * FROM customers ORDER BY last_update DESC`, [], (err, rows) => res.json(rows));
});

app.get('/api/messages/:userId', checkAuth, (req, res) => {
  db.all(`SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp ASC`, [req.params.userId], (err, rows) => res.json(rows));
});

app.post('/api/customers/:userId/read', checkAuth, (req, res) => {
  const adminName = req.session.admin.customName || req.session.admin.displayName; // ใช้นามแฝงถ้ามี
  const now = new Date().toISOString();
  
  db.run(`UPDATE customers SET read_by_name = ?, read_at = ? WHERE user_id = ?`, [adminName, now, req.params.userId], function(err) {
    // อัปเดตรายข้อความเฉพาะฝั่งลูกค้าที่ยังไม่ได้ลงชื่อว่าใครอ่าน
    db.run(`UPDATE messages SET read_by_name = ? WHERE user_id = ? AND sender = 'customer' AND read_by_name IS NULL`, [adminName, req.params.userId], function(errMsg) {
      io.emit('updateReadStatus', { userId: req.params.userId, readByName: adminName, readAt: now });
      res.json({ success: true });
    });
  });
});

app.post('/api/customers/:userId/status', checkAuth, async (req, res) => {
  const { status } = req.body;
  
  // ถ้าระบุสถานะเป็น completed ให้เคลียร์คะแนน rating ของรอบเก่าทิ้งด้วย เพื่อให้ลูกค้ากดโหวตใหม่ได้
  let updateQuery = `UPDATE customers SET status = ? WHERE user_id = ?`;
  if (status === 'completed') {
    updateQuery = `UPDATE customers SET status = ?, rating = NULL WHERE user_id = ?`;
  }
  
  db.run(updateQuery, [status, req.params.userId], async function(err) {
    io.emit('updateCustomerStatusOnly', { userId: req.params.userId, status });
    
    if (status === 'completed') {
      try {
        await client.pushMessage({
          to: req.params.userId,
          messages: [{
            type: 'flex',
            altText: 'กรุณาให้คะแนนการบริการ',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  { type: 'text', text: 'ให้คะแนนการบริการ ⭐', weight: 'bold', size: 'lg', align: 'center' },
                  { type: 'text', text: 'เลือกระดับคะแนน (1 แย่มาก - 5 ดีมาก)', size: 'xs', color: '#aaaaaa', align: 'center', margin: 'sm' }
                ]
              },
              footer: {
                type: 'box',
                layout: 'horizontal',
                spacing: 'xs',
                contents: [
                  { type: 'button', style: 'primary', height: 'sm', color: '#ffb300', action: { type: 'postback', label: '1', data: 'action=rate&score=1' } },
                  { type: 'button', style: 'primary', height: 'sm', color: '#ffb300', action: { type: 'postback', label: '2', data: 'action=rate&score=2' } },
                  { type: 'button', style: 'primary', height: 'sm', color: '#ffb300', action: { type: 'postback', label: '3', data: 'action=rate&score=3' } },
                  { type: 'button', style: 'primary', height: 'sm', color: '#ffb300', action: { type: 'postback', label: '4', data: 'action=rate&score=4' } },
                  { type: 'button', style: 'primary', height: 'sm', color: '#ffb300', action: { type: 'postback', label: '5', data: 'action=rate&score=5' } }
                ]
              }
            }
          }]
        });
      } catch (e) { console.error('Error sending rating msg', e); }
    }
    
    res.json({ success: true });
  });
});

app.post('/api/customers/:userId/claim', checkAuth, (req, res) => {
  const adminId = req.session.admin.userId;
  db.run(`UPDATE customers SET handled_by = ? WHERE user_id = ?`, [adminId, req.params.userId], function(err) {
    io.emit('updateCustomerClaim', { userId: req.params.userId, handledBy: adminId });
    res.json({ success: true });
  });
});

app.post('/api/customers/:userId/note', checkAuth, (req, res) => {
  const { note } = req.body;
  db.run(`UPDATE customers SET internal_note = ? WHERE user_id = ?`, [note, req.params.userId], function(err) {
    res.json({ success: true });
  });
});

app.post('/api/reply', checkAuth, async (req, res) => {
  const { userId, text, type, imageBase64, fileBase64, fileName } = req.body;
  const admin = req.session.admin;
  const now = new Date().toISOString();
  
  // เลือกใช้ชื่อ: ถ้าตั้ง customName ไว้ให้ใช้ชื่อนั้น ถ้าไม่ได้ตั้งให้ใช้ชื่อ LINE ปกติ
  const senderName = admin.customName || admin.displayName;

  try {
    let lineMessage = {};
    let savedFileUrl = null;
    let msgType = type || 'text';
    let msgText = text;
    
    // ใช้ fileBase64 ถ้ามี หรือใช้ imageBase64
    const base64Input = fileBase64 || imageBase64;

    if ((msgType === 'image' || msgType === 'file') && base64Input) {
      const isPdf = msgType === 'file';
      const base64Data = base64Input.replace(/^data:(image|application)\/\w+;base64,/, "");
      
      let ext = isPdf ? 'pdf' : 'jpg';
      if (!isPdf && base64Input.indexOf(';base64') > -1) {
        ext = base64Input.substring("data:image/".length, base64Input.indexOf(";base64"));
      }
      
      const generatedName = isPdf ? `file_${Date.now()}.${ext}` : `img_${Date.now()}.${ext}`;
      const buffer = Buffer.from(base64Data, 'base64');
      
      await supabase.storage.from('uploads').upload(generatedName, buffer, {
        contentType: isPdf ? 'application/pdf' : `image/${ext}`
      });
      
      const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(generatedName);
      const secureUrl = publicUrlData.publicUrl;
      
      savedFileUrl = secureUrl;
      
      if (isPdf) {
        msgText = `[ส่งไฟล์ PDF]`;
        lineMessage = {
          type: 'flex',
          altText: `ไฟล์เอกสาร: ${fileName || 'เอกสาร.pdf'}`,
          sender: { name: senderName },
          contents: {
            type: 'bubble',
            size: 'kilo',
            body: {
              type: 'box',
              layout: 'horizontal',
              contents: [
                {
                  type: 'text',
                  text: '📄',
                  size: 'xl',
                  flex: 0,
                  align: 'center',
                  gravity: 'center'
                },
                {
                  type: 'box',
                  layout: 'vertical',
                  contents: [
                    {
                      type: 'text',
                      text: fileName || 'ไฟล์เอกสาร.pdf',
                      weight: 'bold',
                      size: 'sm',
                      wrap: true
                    },
                    {
                      type: 'text',
                      text: 'แตะเพื่อเปิดดูหรือดาวน์โหลด',
                      size: 'xs',
                      color: '#aaaaaa',
                      wrap: true
                    }
                  ],
                  margin: 'md',
                  flex: 1
                }
              ],
              spacing: 'md',
              alignItems: 'center',
              action: {
                type: 'uri',
                label: 'action',
                uri: secureUrl
              }
            }
          }
        };
      } else {
        msgText = '[รูปภาพ]';
        lineMessage = {
          type: 'image',
          originalContentUrl: secureUrl,
          previewImageUrl: secureUrl,
          sender: { name: senderName }
        };
      }
    } else {
      lineMessage = {
        type: 'text',
        text: text,
        sender: { name: senderName }
      };
    }

    await client.pushMessage({
      to: userId,
      messages: [lineMessage]
    });

    db.run(
      `INSERT INTO messages (user_id, sender, admin_name, admin_picture, text, timestamp, admin_id, msg_type, file_url) VALUES (?, 'admin', ?, ?, ?, ?, ?, ?, ?)`,
      [userId, senderName, admin.pictureUrl, msgText, now, admin.userId, msgType, savedFileUrl]
    );
    db.run(`UPDATE customers SET status = 'in_progress', last_update = ? WHERE user_id = ?`, [now, userId]);

    io.emit('newMessage', { userId, sender: 'admin', adminName: senderName, adminPicture: admin.pictureUrl, text: msgText, timestamp: now, msgType, fileUrl: savedFileUrl });
    io.emit('updateCustomer', { userId, status: 'in_progress', last_update: now });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reply Error:', err.statusCode || '', err.message, err.originalError?.response?.data || '');
    res.status(500).json({ error: err.message });
  }
});

server.listen(port, () => console.log(`✅ Server is running on http://localhost:${port}`));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ พอร์ต ${port} ถูกใช้งานอยู่แล้ว กรุณาปิดโปรแกรมที่ใช้พอร์ตนี้ หรือเปลี่ยนค่า PORT ใน .env`);
  } else {
    console.error('❌ Server Error:', err);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});