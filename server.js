/**
 * Smart Student & Worker Attendance Management System — Dynamic QR Codes
 * Single-file Express backend. SQLite (file-based) storage, JWT auth,
 * photo upload on enrollment, time-rotating cryptographic QR tokens,
 * optional geofencing, live attendance feed, CSV export.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
// Node's own built-in SQLite (Node 22.5+) — no compiler/build tools required,
// unlike the native "better-sqlite3" package. Currently marked experimental
// by Node itself (it prints a harmless warning on startup) but fully usable.
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const QR_INTERVAL_SEC = 30; // QR token refreshes every 30 seconds

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`Smart QR Attendance server running at http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy, retrying on http://localhost:${nextPort}`);
      startServer(nextPort);
      return;
    }
    throw err;
  });
}

// ---------- storage dirs ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(__dirname, 'attendance.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('student','worker','lecturer','admin')),
  full_name TEXT NOT NULL,
  id_number TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  department TEXT,
  password_hash TEXT NOT NULL,
  photo_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  lecturer_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(lecturer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  photo_path TEXT,
  enrolled_at TEXT DEFAULT (datetime('now')),
  UNIQUE(student_id, course_id),
  FOREIGN KEY(student_id) REFERENCES users(id),
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  secret TEXT NOT NULL,
  lat REAL,
  lng REAL,
  radius_m REAL,
  expires_at INTEGER NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  scanned_at TEXT DEFAULT (datetime('now')),
  lat REAL,
  lng REAL,
  UNIQUE(session_id, student_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(student_id) REFERENCES users(id)
);
`);

// ---------- helpers ----------
function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.full_name }, JWT_SECRET, { expiresIn: '12h' });
}

function auth(requiredRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (requiredRoles && !requiredRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Not authorized for this action' });
      }
      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function bucketFor(tsSeconds) {
  return Math.floor(tsSeconds / QR_INTERVAL_SEC);
}

function tokenFor(sessionId, bucket, secret) {
  return crypto.createHmac('sha256', secret).update(`${sessionId}:${bucket}`).digest('hex').slice(0, 16);
}

// Haversine distance in metres
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image uploads are allowed'));
    cb(null, true);
  },
});

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ===== AUTH =====
app.post('/api/auth/signup', (req, res) => {
  const { role, fullName, idNumber, email, password, department } = req.body;
  if (!role || !fullName || !idNumber || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!['student', 'worker', 'lecturer', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      'INSERT INTO users (role, full_name, id_number, email, department, password_hash) VALUES (?,?,?,?,?,?)'
    )
    .run(role, fullName, idNumber, email, department || null, passwordHash);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = signToken(user);
  res.json({ token, user: sanitizeUser(user) });
});

function sanitizeUser(u) {
  return {
    id: u.id,
    role: u.role,
    fullName: u.full_name,
    idNumber: u.id_number,
    email: u.email,
    department: u.department,
    photoUrl: u.photo_path ? `/uploads/${u.photo_path}` : null,
  };
}

app.get('/api/me', auth(), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(sanitizeUser(user));
});

// Update / add a general profile photo (optional, independent of per-course enrollment photo)
app.post('/api/me/photo', auth(), upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  db.prepare('UPDATE users SET photo_path = ? WHERE id = ?').run(req.file.filename, req.user.id);
  res.json({ photoUrl: `/uploads/${req.file.filename}` });
});

// ===== COURSES =====
app.get('/api/courses', auth(), (req, res) => {
  let rows;
  if (req.user.role === 'lecturer') {
    rows = db.prepare('SELECT * FROM courses WHERE lecturer_id = ? ORDER BY id DESC').all(req.user.id);
  } else {
    rows = db.prepare('SELECT courses.*, users.full_name AS lecturer_name FROM courses JOIN users ON users.id = courses.lecturer_id ORDER BY courses.id DESC').all();
  }
  res.json(rows);
});

app.post('/api/courses', auth(['lecturer', 'admin']), (req, res) => {
  const { code, title } = req.body;
  if (!code || !title) return res.status(400).json({ error: 'Course code and title are required' });
  const info = db
    .prepare('INSERT INTO courses (code, title, lecturer_id) VALUES (?,?,?)')
    .run(code, title, req.user.id);
  res.json(db.prepare('SELECT * FROM courses WHERE id = ?').get(info.lastInsertRowid));
});

// Student/worker enrolls in a course AND uploads an identification photo at the same time
app.post('/api/courses/:id/enroll', auth(['student', 'worker']), upload.single('photo'), (req, res) => {
  const courseId = Number(req.params.id);
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (!req.file) return res.status(400).json({ error: 'A photo is required to enroll, so the lecturer can identify you after scanning' });

  const already = db.prepare('SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?').get(req.user.id, courseId);
  if (already) return res.status(409).json({ error: 'You are already enrolled in this course' });

  db.prepare('INSERT INTO enrollments (student_id, course_id, photo_path) VALUES (?,?,?)').run(
    req.user.id,
    courseId,
    req.file.filename
  );
  // Also set this as the user's general profile photo if they don't have one yet
  const user = db.prepare('SELECT photo_path FROM users WHERE id = ?').get(req.user.id);
  if (!user.photo_path) db.prepare('UPDATE users SET photo_path = ? WHERE id = ?').run(req.file.filename, req.user.id);

  res.json({ ok: true, photoUrl: `/uploads/${req.file.filename}` });
});

app.get('/api/courses/:id/my-enrollment', auth(['student', 'worker']), (req, res) => {
  const row = db
    .prepare('SELECT * FROM enrollments WHERE student_id = ? AND course_id = ?')
    .get(req.user.id, Number(req.params.id));
  res.json(row || null);
});

app.get('/api/students/me/courses', auth(['student', 'worker']), (req, res) => {
  const rows = db
    .prepare(
      `SELECT courses.*, users.full_name AS lecturer_name FROM enrollments
       JOIN courses ON courses.id = enrollments.course_id
       JOIN users ON users.id = courses.lecturer_id
       WHERE enrollments.student_id = ?`
    )
    .all(req.user.id);
  res.json(rows);
});

// Roster with photos — this is what the lecturer/admin uses to visually identify students
app.get('/api/courses/:id/roster', auth(['lecturer', 'admin']), (req, res) => {
  const rows = db
    .prepare(
      `SELECT users.id, users.full_name, users.id_number, users.department,
              enrollments.photo_path, enrollments.enrolled_at
       FROM enrollments
       JOIN users ON users.id = enrollments.student_id
       WHERE enrollments.course_id = ?
       ORDER BY users.full_name`
    )
    .all(req.params.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      idNumber: r.id_number,
      department: r.department,
      photoUrl: r.photo_path ? `/uploads/${r.photo_path}` : null,
      enrolledAt: r.enrolled_at,
    }))
  );
});

// ===== SESSIONS (dynamic QR) =====
app.post('/api/sessions', auth(['lecturer', 'admin']), (req, res) => {
  const { courseId, durationMinutes, lat, lng, radiusM } = req.body;
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (req.user.role === 'lecturer' && course.lecturer_id !== req.user.id) {
    return res.status(403).json({ error: 'You do not own this course' });
  }
  const secret = crypto.randomBytes(16).toString('hex');
  const durMin = Number(durationMinutes) > 0 ? Number(durationMinutes) : 15;
  const expiresAt = Math.floor(Date.now() / 1000) + durMin * 60;

  const info = db
    .prepare('INSERT INTO sessions (course_id, secret, lat, lng, radius_m, expires_at) VALUES (?,?,?,?,?,?)')
    .run(courseId, secret, lat ?? null, lng ?? null, radiusM ?? null, expiresAt);

  res.json({ id: info.lastInsertRowid, courseId, expiresAt, qrIntervalSec: QR_INTERVAL_SEC });
});

app.get('/api/sessions/:id/qr-payload', auth(['lecturer', 'admin']), (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session || !session.active) return res.status(404).json({ error: 'Session not found or ended' });
  const now = Math.floor(Date.now() / 1000);
  if (now > session.expires_at) return res.status(410).json({ error: 'Session has expired' });

  const bucket = bucketFor(now);
  const token = tokenFor(session.id, bucket, session.secret);
  const uniqueCode = crypto.randomBytes(8).toString('hex');
  const secondsLeftInBucket = QR_INTERVAL_SEC - (now % QR_INTERVAL_SEC);
  const secondsLeftInSession = session.expires_at - now;

  res.json({
    payload: JSON.stringify({ sid: session.id, tok: token, ts: bucket, uid: uniqueCode }),
    refreshInSec: secondsLeftInBucket,
    sessionSecondsLeft: secondsLeftInSession,
  });
});

app.post('/api/sessions/:id/end', auth(['lecturer', 'admin']), (req, res) => {
  db.prepare('UPDATE sessions SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Live attendance feed for a session — polled by the lecturer's dashboard.
// Returns each scan with the student's enrollment photo for quick visual ID.
app.get('/api/sessions/:id/attendance', auth(['lecturer', 'admin']), (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const rows = db
    .prepare(
      `SELECT attendance.id, attendance.scanned_at, users.full_name, users.id_number,
              (SELECT photo_path FROM enrollments WHERE student_id = users.id AND course_id = ?) AS photo_path
       FROM attendance
       JOIN users ON users.id = attendance.student_id
       WHERE attendance.session_id = ?
       ORDER BY attendance.scanned_at DESC`
    )
    .all(session.course_id, session.id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      idNumber: r.id_number,
      scannedAt: r.scanned_at,
      photoUrl: r.photo_path ? `/uploads/${r.photo_path}` : null,
    }))
  );
});

// ===== SCAN & MARK ATTENDANCE =====
app.post('/api/attendance/scan', auth(['student', 'worker']), (req, res) => {
  const { sid, tok, ts, lat, lng, accuracy } = req.body;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!session || !session.active) return res.status(404).json({ error: 'This QR code is no longer active' });

  const now = Math.floor(Date.now() / 1000);
  if (now > session.expires_at) return res.status(410).json({ error: 'This session has ended' });

  const currentBucket = bucketFor(now);
  const validBuckets = [currentBucket, currentBucket - 1]; // small grace window for clock/network drift
  const expected = validBuckets.map((b) => tokenFor(session.id, b, session.secret));
  if (!expected.includes(tok)) {
    return res.status(400).json({ error: 'QR code has expired — ask the lecturer for the current code' });
  }

  const enrolled = db
    .prepare('SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?')
    .get(req.user.id, session.course_id);
  if (!enrolled) return res.status(403).json({ error: 'You are not enrolled in this course' });

  const already = db
    .prepare('SELECT id FROM attendance WHERE session_id = ? AND student_id = ?')
    .get(session.id, req.user.id);
  if (already) return res.status(409).json({ error: 'Attendance already recorded for this session' });

  if (session.lat != null && session.lng != null && session.radius_m != null) {
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'Location is required for this session' });
    }
    const dist = distanceMeters(session.lat, session.lng, lat, lng);
    const gpsAccuracy = Number(accuracy) || 0;
    const allowedDistance = Math.max(session.radius_m - gpsAccuracy * 0.75, 0);
    if (dist > allowedDistance) {
      return res.status(403).json({
        error: `You appear to be outside the venue (about ${Math.round(dist)}m away; GPS accuracy ~${Math.round(gpsAccuracy)}m)`,
      });
    }
  }

  db.prepare('INSERT INTO attendance (session_id, student_id, lat, lng) VALUES (?,?,?,?)').run(
    session.id,
    req.user.id,
    lat ?? null,
    lng ?? null
  );

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(session.course_id);
  res.json({ ok: true, course: course.title, time: new Date().toISOString() });
});

app.get('/api/students/me/attendance', auth(['student', 'worker']), (req, res) => {
  const rows = db
    .prepare(
      `SELECT attendance.scanned_at, courses.code, courses.title
       FROM attendance
       JOIN sessions ON sessions.id = attendance.session_id
       JOIN courses ON courses.id = sessions.course_id
       WHERE attendance.student_id = ?
       ORDER BY attendance.scanned_at DESC`
    )
    .all(req.user.id);
  res.json(rows);
});

// ===== REPORTS =====
app.get('/api/courses/:id/report.csv', auth(['lecturer', 'admin']), (req, res) => {
  const rows = db
    .prepare(
      `SELECT users.full_name, users.id_number, attendance.scanned_at, sessions.id AS session_id
       FROM attendance
       JOIN sessions ON sessions.id = attendance.session_id
       JOIN users ON users.id = attendance.student_id
       WHERE sessions.course_id = ?
       ORDER BY attendance.scanned_at`
    )
    .all(req.params.id);

  let csv = 'Full Name,ID Number,Session ID,Scanned At\n';
  rows.forEach((r) => {
    csv += `"${r.full_name}","${r.id_number}",${r.session_id},"${r.scanned_at}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="course-${req.params.id}-attendance.csv"`);
  res.send(csv);
});

// ===== ADMIN =====
app.get('/api/admin/users', auth(['admin']), (req, res) => {
  const rows = db.prepare('SELECT id, role, full_name, id_number, email, department, created_at FROM users ORDER BY id DESC').all();
  res.json(rows);
});

app.get('/api/admin/overview', auth(['admin']), (req, res) => {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const courses = db.prepare('SELECT COUNT(*) c FROM courses').get().c;
  const attendanceCount = db.prepare('SELECT COUNT(*) c FROM attendance').get().c;
  res.json({ users, courses, attendanceCount });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

startServer(DEFAULT_PORT);
