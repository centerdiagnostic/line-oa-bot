# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A LINE Official Account (OA) customer-support console: a Node/Express server that receives LINE
webhook messages from customers, stores the conversation in Postgres (Supabase), and exposes a
real-time admin dashboard (Socket.IO) where staff reply, claim chats, broadcast rich messages, and
manage quick replies. Nearly the entire application — backend and frontend — lives in two files:

- `server.js` (~1600 lines) — Express app, LINE webhook handler, all REST APIs, admin HTML pages
  (`/manage`, `/summary`, `/manage_qr`, `/manage_rich_msg`, `/login`, `/pending`) rendered as inline
  template strings, and Socket.IO event emission.
- `index.html` (~2300 lines) — the main admin dashboard (`/dashboard`). A single static page with
  inline `<style>` and `<script>` — no build step, no frontend framework, no bundler.

There is no test suite (`npm test` is a stub) and no linter configured.

## Commands

```bash
npm install       # install dependencies
npm start          # node server.js — starts the server (default PORT=3000)
```

There is no dev/watch script — restart the process manually after editing `server.js`. Changes to
`index.html` only need a browser refresh, since it's served fresh from disk on each request
(`res.sendFile`) rather than bundled or cached in memory.

## Architecture

### Request flow
1. **Customer → LINE → webhook**: `POST /webhook` (`line.middleware(config)` verifies the LINE
   signature) → `handleEvent(event)` in `server.js`. Handles `message` events (`text`, `image`,
   `file`, `sticker`) and `postback` events (satisfaction-rating buttons sent after a chat closes).
2. Incoming media (`image`/`file`) is streamed from LINE via `blobClient.getMessageContent`,
   buffered, and re-uploaded to the Supabase Storage bucket `uploads`; the public URL is what gets
   stored in Postgres and shown in the dashboard.
3. New messages/customer updates are persisted via the `db` wrapper (see below) and broadcast to
   all connected admin browsers with `io.emit('newMessage', ...)` / `io.emit('updateCustomer', ...)`.
   A push notification (`sendPushToAllAdmins`) also fires via `web-push`/VAPID for any subscribed
   admin browser.
4. **Admin → dashboard**: admins reply through `POST /api/reply`, which uploads any attached file to
   Supabase Storage, calls `client.pushMessage` (LINE Messaging API) to deliver it, persists the
   message, and emits the same Socket.IO events so every open dashboard tab updates live.
5. The dashboard (`index.html`) is a single Socket.IO client (`const socket = io()`) plus plain
   `fetch()` calls to the REST endpoints below — no client-side router or framework.

### `db` — SQLite-shaped wrapper over Postgres
`server.js` defines a small `db.run/get/all(sql, params, callback)` shim (around line 78) that
rewrites `?` placeholders to `$1, $2, …` and executes against the `pg` `Pool`. It exists so
callback-style SQLite-era code keeps working after the migration to Supabase/Postgres — new code in
this file should keep using this `db.*` style (or `pool.query` directly for `async/await`, as
`/api/reply` and the webhook's media upload paths do) rather than introducing a different DB client.
`db.run` auto-appends `RETURNING *` to bare `INSERT`s so `this.lastID` works in callbacks.

### Tables (auto-created on boot, see `server.js` ~line 122)
`admins`, `customers`, `messages`, `quick_replies`, `ratings`, `rich_messages`,
`push_subscriptions`. Schema changes belong in this `CREATE TABLE IF NOT EXISTS` block, not in a
separate migration file — there isn't one.

### Auth & roles
LINE Login (`/auth/line` → `/auth/line/callback`) is the only sign-in path for the admin dashboard —
separate from the Messaging API channel used for the bot itself (`.env` has distinct
`LINE_CHANNEL_*` vs `LINE_LOGIN_CHANNEL_*` credentials). Sessions are stored server-side in Postgres
via `connect-pg-simple` (table `user_sessions`, auto-created).

Roles live in the `admins` table and session (`req.session.admin`):
- `pending` — newly logged-in users default here; blocked by `checkAuth` and redirected to `/pending`
  until an admin promotes them via `/manage`.
- `admin` — required by `checkAdminRole` for `/manage`, `/summary`, `/manage_qr`, quick-reply CRUD,
  user-role management, and status changes.
- `can_broadcast` (boolean, independent of role) — required by `checkBroadcastRole` for
  `/manage_rich_msg` and the rich-message APIs.
- `FIRST_ADMIN_USER_ID` in `.env` is auto-granted `admin` + `can_broadcast` on first login,
  bootstrapping the very first administrator.

### Customer chat lifecycle
`customers.status` moves `pending` → `in_progress` (set automatically when an admin replies) →
whatever an admin sets via `POST /api/customers/:userId/status`. `handled_by` tracks which admin
claimed the chat (`POST /api/customers/:userId/claim`); ratings collected via LINE postback buttons
are written to both `customers.rating` (latest, used to prevent double-rating) and the `ratings`
table (full history per admin).

### File uploads
All chat attachments (both directions) go to the Supabase Storage `uploads` bucket, not local disk —
the `uploads/` directory in this repo is unused/legacy (and gitignored). Images are stored as
`image/jpeg`-ish blobs with a `Date.now()`-based filename; PDFs are sent to LINE as a `flex` message
bubble (LINE has no native file-message type) with a tap-to-open URI action.

### Environment (`.env`, gitignored)
`LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` — Messaging API (the bot itself).
`LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET` — LINE Login (admin dashboard auth).
`SESSION_SECRET`, `FIRST_ADMIN_USER_ID`, `BASE_URL`, `PORT`.
`SUPABASE_URL`, `SUPABASE_KEY` — Storage + client.
`DATABASE_URL` — Postgres connection string (used directly via `pg`, separate from the Supabase JS client).
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — Web Push notifications to admin browsers.

## Conventions in this codebase

- Server-rendered admin pages (`/manage`, `/summary`, `/manage_qr`, `/manage_rich_msg`, `/login`,
  `/pending`) are HTML template literals returned directly from `server.js` route handlers — there is
  no templating engine (no EJS/Pug). Follow the same pattern (inline `<style>`, inline `<script>`,
  string-concatenated into `res.send(...)`) when touching these rather than introducing a template
  engine.
- Comments and console logs throughout `server.js` are written in Thai; match that when editing
  nearby code rather than switching to English mid-file.
- Real-time UI updates always go through Socket.IO broadcasts (`io.emit(...)`), not polling — any
  new state change an admin needs to see live should emit an event and the corresponding
  `socket.on(...)` handler should be added in `index.html`.
- Body size limits (`express.json({limit:'50mb'})`) are set to accommodate base64-encoded image/file
  uploads sent from the dashboard (`imageBase64`/`fileBase64` fields on `POST /api/reply`) — this is
  intentional, not an oversight.
  ## กฎการทำงานกับผู้ใช้ (บังคับ)

- อธิบายทุกอย่างเป็นภาษาไทย ผู้ใช้อ่านโค้ดไม่เป็น ให้อธิบายว่า "โค้ดนี้ทำอะไร" ด้วยภาษาคนทั่วไป ห้ามตอบเป็นศัพท์เทคนิคล้วน
- ก่อนแก้ไฟล์ใด ๆ ต้องบอกก่อนว่าจะแก้ไฟล์ไหน บรรทัดไหน และแก้เพราะอะไร แล้วรอให้ผู้ใช้อนุมัติ
- ห้ามแก้เกินกว่าที่สั่ง ถ้าเห็นจุดอื่นที่ควรแก้ ให้ "เสนอ" ไว้ท้ายคำตอบ ห้ามลงมือแก้เอง
- ห้ามแตะไฟล์ .env และห้ามพิมพ์ค่าใน .env ออกมาบนหน้าจอเด็ดขาด
- ห้ามลบหรือแก้โครงสร้างตาราง (CREATE TABLE) ที่มีอยู่เดิม ถ้าจำเป็นต้องเพิ่มคอลัมน์ ให้เสนอก่อน
- ห้ามติดตั้ง framework, bundler หรือ template engine ใหม่ โปรเจกต์นี้ตั้งใจให้เป็น vanilla ไม่มี build step
- ห้ามรัน git reset, git checkout, หรือคำสั่งที่ลบไฟล์ทิ้งเอง
- หลังแก้เสร็จทุกครั้ง ต้องบอกวิธีทดสอบเป็นขั้นตอน 1-2-3 ว่าต้องกดอะไร เปิดหน้าไหน ถึงจะรู้ว่าใช้ได้จริง
- โค้ดที่รับค่าจากผู้ใช้หรือจาก LINE ต้องกัน SQL Injection เสมอ ใช้ placeholder ผ่าน db.* หรือ pool.query เท่านั้น ห้ามต่อ string เข้า SQL ตรง ๆ
