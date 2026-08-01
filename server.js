const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');

dotenv.config();

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

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

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

const db = {
  serialize: (cb) => cb(),
  run: (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    let i = 0;
    let pgSql = sql.replace(/\?/g, () => `$${++i}`);
    if (pgSql.trim().toUpperCase().startsWith('INSERT') && !pgSql.includes('ON CONFLICT')) {
      pgSql += ' RETURNING id';
    }
    pool.query(pgSql, params || [])
      .then(res => {
        const context = { lastID: res.rows[0]?.id || 0 };
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

function checkAdminRole(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.role === 'admin') next();
  else res.status(403).send('ไม่มีสิทธิ์เข้าถึงหน้านี้ (เฉพาะ Admin)');
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
    let currentRole = 'pending'; // เปลี่ยนค่าเริ่มต้นเป็นรอการอนุมัติ
    let canBroadcast = false;
    
    if (!row) {
      // ตรวจสอบว่าเป็นแอดมินคนแรกที่ระบุใน .env หรือไม่
      if (process.env.FIRST_ADMIN_USER_ID && profile.userId === process.env.FIRST_ADMIN_USER_ID) {
        currentRole = 'admin';
        canBroadcast = true; // แอดมินคนแรกได้สิทธิ์บรอดแคสต์อัตโนมัติ
      }
      db.run(
        `INSERT INTO admins (user_id, display_name, picture_url, custom_name, role, can_broadcast) VALUES (?, ?, ?, NULL, ?, ?)`,
        [profile.userId, profile.displayName, profile.pictureUrl, currentRole, canBroadcast]
      );
    } else {
      currentRole = row.role || 'pending';
      canBroadcast = Boolean(row.can_broadcast);
      db.run(
        `UPDATE admins SET display_name=?, picture_url=? WHERE user_id=?`,
        [profile.displayName, profile.pictureUrl, profile.userId]
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
          // บันทึกคะแนนลงตาราง ratings เพื่อเก็บประวัติทุกรอบแยกกันโดยไม่ทับของเดิม
          db.run(`INSERT INTO ratings (user_id, admin_id, score, timestamp) VALUES (?, ?, ?, ?)`, [event.source.userId, row.handled_by, score, now]);
          
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
    dateConditionMsg = " AND date(timestamp) = ?";
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
                  (SELECT AVG(r.score) FROM ratings r WHERE r.admin_id = m.admin_id) as avg_rating
                FROM messages m 
                LEFT JOIN admins a ON m.admin_id = a.user_id 
                WHERE m.sender = 'admin' ` + dateConditionMsg.replace('timestamp', 'm.timestamp') + `
                GROUP BY COALESCE(m.admin_id, m.admin_name) 
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

app.get('/broadcast', checkAuth, checkBroadcastRole, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>บรอดแคสต์ข้อความ (Broadcast)</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; color: #333; }
        .topbar { background: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .topbar h1 { margin: 0; font-size: 1.2rem; font-weight: bold; }
        .topbar-actions { display: flex; gap: 10px; }
        .btn-outline { background: white; border: 1px solid #ccc; padding: 8px 15px; border-radius: 4px; font-weight: bold; cursor: pointer; color: #333; text-decoration: none; font-size: 0.9rem; }
        .btn-primary { background: #00B900; color: white; border: none; padding: 8px 30px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 0.9rem; }
        .btn-primary:hover { background: #00a000; }
        .layout { display: flex; max-width: 1200px; margin: 20px auto; gap: 20px; padding: 0 20px; align-items: flex-start; }
        .main-content { flex: 1; background: transparent; }
        .section-card { background: white; padding: 20px; margin-bottom: 20px; border: 1px solid #e0e0e0; border-radius: 4px; }
        .row { display: flex; align-items: flex-start; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 15px; }
        .row:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        .col-label { width: 150px; font-weight: bold; font-size: 0.95rem; color: #555; }
        .col-input { flex: 1; }
        .radio-group label { display: block; margin-bottom: 8px; font-size: 0.95rem; cursor: pointer; }
        .radio-group input { margin-right: 8px; }
        .target-box { border: 1px solid #e0e0e0; border-radius: 4px; padding: 20px; width: 180px; text-align: center; margin-left: 20px; }
        .target-circle { width: 80px; height: 80px; border: 4px solid #00B900; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px auto; font-size: 1.2rem; font-weight: bold; }
        
        .msg-editor { border: 1px solid #ccc; border-radius: 4px; overflow: hidden; background: white; margin-bottom: 20px; position: relative;}
        .remove-box-btn { position: absolute; right: 10px; top: 8px; background: none; border: none; color: #aaa; cursor: pointer; font-size: 1.2rem; }
        .remove-box-btn:hover { color: #f44336; }
        .msg-toolbar { background: #f8f9fa; border-bottom: 1px solid #ccc; padding: 5px 10px; display: flex; gap: 10px; }
        .toolbar-btn { background: none; border: none; font-size: 1rem; padding: 8px 12px; cursor: pointer; border-radius: 4px; color: #666; transition: 0.2s; font-weight: bold;}
        .toolbar-btn:hover, .toolbar-btn.active { background: #e9ecef; color: #00B900; }
        .msg-input-area { padding: 15px; min-height: 150px; }
        .msg-textarea { width: 100%; min-height: 120px; border: none; outline: none; font-family: inherit; font-size: 1rem; resize: vertical; }
        .file-upload-box { border: 2px dashed #ccc; border-radius: 8px; padding: 30px; text-align: center; cursor: pointer; background: #fafafa; }
        .file-upload-box:hover { border-color: #00B900; background: #f0fdf0; }
        .add-box-btn { width: 100%; background: transparent; border: 2px dashed #ccc; color: #666; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 1rem; font-weight: bold; transition: 0.2s;}
        .add-box-btn:hover { border-color: #00B900; color: #00B900; background: #f0fdf0; }
        
        .preview-pane { width: 350px; position: sticky; top: 20px; }
        .preview-header { background: #343a40; color: white; padding: 10px 15px; border-radius: 8px 8px 0 0; font-size: 0.9rem; display: flex; justify-content: space-between; }
        .preview-body { background: #8ba2b8; height: 500px; border-radius: 0 0 8px 8px; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        
        .bubble { max-width: 80%; background: #00B900; color: white; padding: 10px 14px; border-radius: 14px; border-top-left-radius: 4px; font-size: 0.95rem; align-self: flex-start; word-wrap: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
        .bubble-img { max-width: 80%; border-radius: 14px; align-self: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
        .bubble-flex { background: white; color: #333; max-width: 85%; padding: 15px; border-radius: 14px; align-self: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.1); border-top-left-radius: 4px; display: flex; gap: 10px; align-items: center; }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>บรอดแคสต์</h1>
        <div class="topbar-actions">
          <a href="/dashboard" class="btn-outline">❮ กลับไปหน้าแชท</a>
          <button class="btn-outline" style="color:#aaa; cursor:not-allowed;" disabled>บันทึกร่าง</button>
          <button class="btn-primary" onclick="sendBroadcast()">ส่ง</button>
        </div>
      </div>
      
      <div class="layout">
        <div class="main-content">
          <div class="section-card">
            <div class="row">
              <div class="col-label">ผู้รับ</div>
              <div class="col-input radio-group">
                <label><input type="radio" checked> เพื่อนทั้งหมด</label>
                <label style="color:#aaa;"><input type="radio" disabled> ระบุ (ใช้งานได้เฉพาะบนแอป LINE)</label>
              </div>
              <div class="target-box">
                <div style="font-size: 0.8rem; color: #666; margin-bottom: 10px;">เป้าหมายโดยประมาณ</div>
                <div class="target-circle">100%</div>
                <div style="font-size: 0.75rem; color: #aaa;">ทุกคนที่ติดตาม</div>
              </div>
            </div>
            <div class="row" style="border-bottom: none; padding-bottom: 0;">
              <div class="col-label">วันบรอดแคสต์</div>
              <div class="col-input radio-group">
                <label><input type="radio" checked> บรอดแคสต์ตอนนี้</label>
              </div>
            </div>
          </div>
          
          <div id="boxes-container">
            <!-- Boxes will be injected here -->
          </div>
          <button class="add-box-btn" onclick="addBox()" id="addBoxBtn">➕ เพิ่มกล่องข้อความ (สูงสุด 5 กล่อง)</button>
          
          <div style="text-align: center; margin-top: 30px;">
            <button class="btn-primary" style="padding: 12px 60px; font-size: 1rem;" onclick="sendBroadcast()">ส่ง</button>
          </div>
        </div>
        
        <div class="preview-pane">
          <div class="preview-header">
            <span>▼ ดูตัวอย่าง</span>
          </div>
          <div class="preview-body" id="previewChat">
            <!-- Preview content will be injected here -->
          </div>
        </div>
      </div>

      <script>
        let boxes = [{ id: Date.now(), type: 'text', text: '', fileBase64: null, fileName: '', richMsgId: '' }];
        let richMessagesList = [];
        
        fetch('/api/rich_messages').then(r=>r.json()).then(data => {
          richMessagesList = data;
          renderBoxes();
        });
        
        function renderBoxes() {
          const container = document.getElementById('boxes-container');
          container.innerHTML = '';
          
          boxes.forEach((box) => {
            const isText = box.type === 'text';
            const isImg = box.type === 'image';
            const isFile = box.type === 'file';
            const isRichMsg = box.type === 'rich_message';
            
            const uploadLabel = isImg ? 'คลิกเพื่ออัปโหลดรูปภาพ' : 'คลิกเพื่ออัปโหลดไฟล์ PDF';
            const acceptType = isImg ? 'image/*' : 'application/pdf';
            
            let rmOptions = '<option value="">-- เลือกรีชเมสเสจ --</option>';
            richMessagesList.forEach(rm => {
              rmOptions += '<option value="' + rm.id + '" ' + (box.richMsgId == rm.id ? 'selected' : '') + '>' + rm.name + '</option>';
            });
            
            let html = '<div class="msg-editor" id="box-' + box.id + '">' +
              (boxes.length > 1 ? '<button class="remove-box-btn" onclick="removeBox(' + box.id + ')" title="ลบกล่องนี้">✖</button>' : '') +
              '<div class="msg-toolbar">' +
                '<button class="toolbar-btn ' + (isText ? 'active' : '') + '" onclick="updateBoxType(' + box.id + ', \\'text\\')" title="ข้อความ">📝 Text</button>' +
                '<button class="toolbar-btn ' + (isImg ? 'active' : '') + '" onclick="updateBoxType(' + box.id + ', \\'image\\')" title="รูปภาพ">🖼️ Image</button>' +
                '<button class="toolbar-btn ' + (isFile ? 'active' : '') + '" onclick="updateBoxType(' + box.id + ', \\'file\\')" title="ไฟล์ PDF">📁 File</button>' +
                '<button class="toolbar-btn ' + (isRichMsg ? 'active' : '') + '" onclick="updateBoxType(' + box.id + ', \\'rich_message\\')" title="ริชเมสเสจ">🎇 Rich Message</button>' +
              '</div>' +
              
              '<div class="msg-input-area" style="display:' + (isText ? 'block' : 'none') + ';">' +
                '<textarea class="msg-textarea" placeholder="ใส่ข้อความ..." oninput="updateBoxText(' + box.id + ', this.value)">' + box.text + '</textarea>' +
              '</div>' +
              
              '<div class="msg-input-area" style="display:' + (isImg || isFile ? 'block' : 'none') + ';">' +
                '<input type="file" id="fileInput-' + box.id + '" style="display:none;" accept="' + acceptType + '" onchange="handleFileSelect(' + box.id + ', event)">' +
                '<div class="file-upload-box" onclick="document.getElementById(\\'fileInput-' + box.id + '\\').click()">' +
                  '<div style="font-size: 2rem; margin-bottom: 10px;">➕</div>' +
                  '<div>' + uploadLabel + '</div>' +
                  '<div style="margin-top: 10px; font-weight: bold; color: #00B900;">' + box.fileName + '</div>' +
                '</div>' +
              '</div>' +

              '<div class="msg-input-area" style="display:' + (isRichMsg ? 'block' : 'none') + ';">' +
                '<label style="font-weight:bold; display:block; margin-bottom:10px;">เลือกริชเมสเสจที่สร้างไว้:</label>' +
                '<select class="form-control" style="width:100%; padding:10px; border-radius:6px; border:1px solid #ccc;" onchange="updateBoxRichMsg(' + box.id + ', this.value)">' +
                  rmOptions +
                '</select>' +
              '</div>' +
            '</div>';
            
            container.insertAdjacentHTML('beforeend', html);
          });
          
          document.getElementById('addBoxBtn').style.display = boxes.length >= 5 ? 'none' : 'block';
          updatePreview();
        }

        function addBox() {
          if (boxes.length < 5) {
            boxes.push({ id: Date.now(), type: 'text', text: '', fileBase64: null, fileName: '', richMsgId: '' });
            renderBoxes();
          }
        }

        function removeBox(id) {
          boxes = boxes.filter(b => b.id !== id);
          renderBoxes();
        }

        function updateBoxType(id, type) {
          const box = boxes.find(b => b.id === id);
          if(box) {
            box.type = type;
            box.fileBase64 = null;
            box.fileName = '';
            renderBoxes();
          }
        }

        function updateBoxText(id, text) {
          const box = boxes.find(b => b.id === id);
          if(box) {
            box.text = text;
            updatePreview();
          }
        }
        
        function updateBoxRichMsg(id, rmId) {
          const box = boxes.find(b => b.id === id);
          if(box) {
            box.richMsgId = rmId;
            updatePreview();
          }
        }

        function handleFileSelect(id, event) {
          const file = event.target.files[0];
          if (!file) return;
          
          const box = boxes.find(b => b.id === id);
          if (!box) return;
          
          box.fileName = file.name;
          const reader = new FileReader();
          reader.onload = function(e) {
            box.fileBase64 = e.target.result;
            renderBoxes();
          };
          reader.readAsDataURL(file);
        }

        function updatePreview() {
          const preview = document.getElementById('previewChat');
          preview.innerHTML = '';
          
          let hasContent = false;
          
          boxes.forEach(box => {
            if (box.type === 'text') {
              if(box.text) {
                const formattedText = box.text
                  .replace(/(https?:\\/\\/[^\\s]+)/g, '<a href="$1" target="_blank" style="color: white; text-decoration: underline; font-weight: bold;">$1</a>')
                  .replace(/\\n/g, '<br>');
                preview.innerHTML += '<div class="bubble">' + formattedText + '</div>';
                hasContent = true;
              }
            } else if (box.type === 'image') {
              if(box.fileBase64) {
                preview.innerHTML += '<img src="' + box.fileBase64 + '" class="bubble-img">';
                hasContent = true;
              }
            } else if (box.type === 'file') {
              if(box.fileBase64) {
                preview.innerHTML += '<div class="bubble-flex"><div style="font-size:2rem;">📄</div><div><div style="font-weight:bold; font-size:0.9rem;">' + box.fileName + '</div><div style="font-size:0.75rem; color:#aaa;">แตะเพื่อเปิดดูหรือดาวน์โหลด</div></div></div>';
                hasContent = true;
              }
            } else if (box.type === 'rich_message') {
              if(box.richMsgId) {
                const rm = richMessagesList.find(r => r.id == box.richMsgId);
                if(rm) {
                  preview.innerHTML += '<div style="width: 100%; border-radius:14px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.1); cursor:pointer;"><img src="' + rm.image_url + '" style="width:100%; display:block;"><div style="background:rgba(0,0,0,0.5); color:white; font-size:0.75rem; padding:6px; text-align:center;">แตะเพื่อเปิดลิงก์</div></div>';
                  hasContent = true;
                }
              }
            }
          });
          
          if(!hasContent) {
            preview.innerHTML = '<div class="bubble" style="opacity:0.5;">ใส่ข้อความเพื่อดูตัวอย่าง...</div>';
          }
        }

        function sendBroadcast() {
          const payloadMessages = [];
          for(let box of boxes) {
            if (box.type === 'text' && box.text.trim()) {
              payloadMessages.push({ type: 'text', text: box.text.trim() });
            } else if ((box.type === 'image' || box.type === 'file') && box.fileBase64) {
              payloadMessages.push({ type: box.type, fileBase64: box.fileBase64, fileName: box.fileName });
            } else if (box.type === 'rich_message' && box.richMsgId) {
              payloadMessages.push({ type: 'rich_message', richMsgId: box.richMsgId });
            }
          }
          
          if(payloadMessages.length === 0) {
            return alert('กรุณาใส่ข้อความ เลือกรูปภาพ ไฟล์ หรือริชเมสเสจ อย่างน้อย 1 กล่อง');
          }

          if(!confirm('คุณแน่ใจหรือไม่ว่าต้องการส่งข้อความนี้หาลูกค้า "ทุกคน"?')) return;
          
          fetch('/api/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: payloadMessages })
          }).then(res => res.json()).then(res => {
            if(res.success) {
              alert('✅ ส่งบรอดแคสต์สำเร็จ!');
              boxes = [{ id: Date.now(), type: 'text', text: '', fileBase64: null, fileName: '', richMsgId: '' }];
              renderBoxes();
            } else {
              alert('❌ เกิดข้อผิดพลาด: ' + (res.error || 'Unknown Error'));
            }
          }).catch(err => alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อ'));
        }

        renderBoxes();
      </script>
    </body>
    </html>
  `);
});

app.post('/api/broadcast', checkAuth, checkBroadcastRole, async (req, res) => {
  const { messages } = req.body;
  const admin = req.session.admin;
  const senderName = admin.customName || admin.displayName;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }
  if (messages.length > 5) {
     return res.status(400).json({ error: 'Cannot send more than 5 messages per broadcast' });
  }

  try {
    let lineMessages = [];

    for (const msg of messages) {
      let msgType = msg.type || 'text';

      if (msgType === 'rich_message' && msg.richMsgId) {
        const rm = await new Promise(resolve => db.get('SELECT * FROM rich_messages WHERE id = ?', [msg.richMsgId], (err, row) => resolve(row)));
        if (rm) {
          lineMessages.push({
            type: 'flex',
            altText: rm.name,
            sender: { name: senderName },
            contents: {
              type: 'bubble',
              size: 'giga',
              hero: {
                type: 'image',
                url: rm.image_url,
                size: 'full',
                aspectRatio: '1:1',
                aspectMode: 'cover',
                action: {
                  type: 'uri',
                  uri: rm.action_value
                }
              }
            }
          });
        }
      } else if ((msgType === 'image' || msgType === 'file') && msg.fileBase64) {
        const isPdf = msgType === 'file';
        const base64Data = msg.fileBase64.split(';base64,').pop();

        let ext = isPdf ? 'pdf' : 'jpg';
        if (!isPdf && msg.fileBase64.indexOf(';base64') > -1) {
          ext = msg.fileBase64.substring("data:image/".length, msg.fileBase64.indexOf(";base64"));
        }

        const generatedName = isPdf ? `file_${Date.now()}_${Math.floor(Math.random()*1000)}.${ext}` : `img_${Date.now()}_${Math.floor(Math.random()*1000)}.${ext}`;
        const buffer = Buffer.from(base64Data, 'base64');
        
        await supabase.storage.from('uploads').upload(generatedName, buffer, {
          contentType: isPdf ? 'application/pdf' : `image/${ext}`
        });
        
        const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(generatedName);
        const secureUrl = publicUrlData.publicUrl;

        if (isPdf) {
          lineMessages.push({
            type: 'flex',
            altText: `ไฟล์เอกสารบรอดแคสต์: ${msg.fileName || 'เอกสาร.pdf'}`,
            sender: { name: senderName },
            contents: {
              type: 'bubble', size: 'kilo',
              body: {
                type: 'box', layout: 'horizontal',
                contents: [
                  { type: 'text', text: '📄', size: 'xl', flex: 0, align: 'center', gravity: 'center' },
                  {
                    type: 'box', layout: 'vertical', margin: 'md', flex: 1,
                    contents: [
                      { type: 'text', text: msg.fileName || 'ไฟล์เอกสาร.pdf', weight: 'bold', size: 'sm', wrap: true },
                      { type: 'text', text: 'แตะเพื่อเปิดดูหรือดาวน์โหลด', size: 'xs', color: '#aaaaaa', wrap: true }
                    ]
                  }
                ],
                spacing: 'md', alignItems: 'center',
                action: { type: 'uri', label: 'action', uri: secureUrl }
              }
            }
          });
        } else {
          lineMessages.push({
            type: 'image',
            originalContentUrl: secureUrl,
            previewImageUrl: secureUrl,
            sender: { name: senderName }
          });
        }
      } else {
        if (!msg.text) continue;
        lineMessages.push({
          type: 'text',
          text: msg.text,
          sender: { name: senderName }
        });
      }
    }

    if (lineMessages.length === 0) {
        return res.status(400).json({ error: 'No valid messages to send' });
    }

    await client.broadcast({ messages: lineMessages });
    res.json({ success: true });
  } catch (err) {
    console.error('Broadcast Error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});

server.listen(port, () => console.log(`Server is running on port ${port}`));