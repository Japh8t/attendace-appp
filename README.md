# SmartAttend — QR Attendance Management System

A real, mobile-friendly website for taking attendance with dynamic (auto-refreshing)
QR codes. Built to match the "Smart Student and Worker Attendance Management
System Using Dynamic QR Codes" project — implemented as a responsive **web app**
(not a native app) so it works on any phone, tablet, or laptop browser.

## What it does

- **Students/workers** create an account, enroll in a course, and **upload a
  photo of themselves at enrollment**. That photo is attached to their
  enrollment record.
- **Lecturers/admins** see every enrolled student's photo in a roster grid, and
  when someone scans in, that student's photo appears instantly in the live
  attendance feed — so you can glance at the phone/screen and visually confirm
  it's really them, no extra hardware needed.
- The QR code shown on the lecturer's screen **rotates every 15 seconds**
  (a signed, time-boxed token), so a screenshot stops working almost
  immediately — this is what stops "proxy" attendance (one student scanning
  for absent friends).
- Optional **geofencing**: the lecturer can require students to be within a
  set radius (metres) of their location to scan in successfully.
- Duplicate scans for the same session are rejected automatically.
- CSV export of attendance per course (open it in Excel/Sheets, or use your
  browser's Print → Save as PDF on the Reports page for a PDF copy).
- Fully responsive: works great on a phone (student scanning) and on a
  desktop/tablet (lecturer's projector/laptop showing the QR code).

## Tech stack

- **Backend:** Node.js + Express, SQLite (via Node's own **built-in**
  `node:sqlite` module — a single local file, no separate database server
  and, importantly, no C++ compiler needed on your machine), JWT auth,
  `multer` for photo uploads. Requires **Node.js 22.5 or newer** (Node
  prints a one-line "SQLite is experimental" notice on startup — that's
  expected and harmless).
- **Frontend:** Plain HTML/CSS/JavaScript (no build step) — a small
  single-page app that talks to the API. QR generation uses `qrcodejs`;
  scanning uses `jsQR`, both loaded from a CDN.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18+ installed.

```bash
cd attendance-app
npm install
npm start
```

Then open **http://localhost:3000** — on your phone too, if it's on the same
Wi-Fi as your computer, using your computer's local IP instead of
`localhost` (e.g. `http://192.168.1.20:3000`). For camera access
(scanning/photo upload) to work on a phone over plain HTTP, most browsers
require either `localhost` or **HTTPS** — see the deployment section below
for a real HTTPS domain.

Create at least one **lecturer** account and one **student** account to try
the full flow:

1. Sign up as a lecturer → Courses tab → create a course.
2. Sign up as a student (or worker) → Courses tab → Enroll → upload a photo.
3. As the lecturer → Live Session tab → pick the course → Generate QR code.
4. As the student → Scan tab → point the camera at the lecturer's screen.
5. Back on the lecturer's screen, watch the student's name and photo appear
   in the live attendance feed.

## Deploying it as a real, public website

Because camera access requires HTTPS, deploy it somewhere that gives you a
free HTTPS domain automatically. Any of these work well for this app (it's a
plain Node.js app with a local SQLite file):

- **Render** (render.com) — "New Web Service", connect your repo,
  build command `npm install`, start command `npm start`. Free tier is fine
  to try it out. Note: the free tier's disk is not permanent — for a real
  deployment with lasting uploads/data, add a persistent disk (Render offers
  small free/paid persistent disks) mounted at the project folder, or switch
  the `uploads/` folder and `attendance.db` path to that disk's mount point.
- **Railway** (railway.app) — similar one-click Node deploy with a
  persistent volume you can attach for `uploads/` and `attendance.db`.
- **Fly.io** — deploy via `fly launch`, attach a small persistent volume the
  same way.

Whichever host you choose, set the environment variable `JWT_SECRET` to a
long random string in production (don't leave the default in `server.js`).

## Project structure

```
attendance-app/
  server.js            # Express API + static file serving
  package.json
  public/
    index.html
    css/style.css
    js/app.js           # the whole front-end app
  uploads/              # student photos land here (served at /uploads/...)
  attendance.db          # created automatically on first run
```

## Notes on the design decisions

- **Photo at enrollment, not just at signup:** the photo is tied to the
  *enrollment* record (per course), matching how the roster and live scan
  feed look it up — if a student uploads a fresh photo for a course later,
  admins can re-enroll them for an updated one.
- **Why SQLite:** it's a single file, needs no separate database server to
  install, and is more than enough for a departmental-scale deployment. If
  you outgrow it, the SQL is close enough to standard that moving to
  Postgres/MySQL later is a small, contained change in `server.js`.
- **Why no native mobile app:** the brief asked for a real *website* that
  works on mobile — a responsive web app avoids app-store distribution
  entirely and updates instantly for everyone, at the cost of relying on the
  phone's browser for camera access (which all modern mobile browsers
  support well over HTTPS).
