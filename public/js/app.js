// ---------- tiny app state ----------
const state = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  tab: null,
};

const app = document.getElementById('app');
const navLinks = document.getElementById('navLinks');
const logoutBtn = document.getElementById('logoutBtn');

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ---------- API helper ----------
async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (!isForm && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

logoutBtn.addEventListener('click', () => {
  clearSession();
  render();
});

// ---------- nav ----------
function renderNav() {
  navLinks.innerHTML = '';
  logoutBtn.classList.toggle('hidden', !state.user);
  if (!state.user) return;

  const tabsByRole = {
    student: [['courses', 'Courses'], ['scan', 'Scan'], ['history', 'History']],
    worker: [['courses', 'Courses'], ['scan', 'Scan'], ['history', 'History']],
    lecturer: [['courses', 'Courses'], ['session', 'Live Session'], ['reports', 'Reports']],
    admin: [['admin', 'Admin']],
  };
  const tabs = tabsByRole[state.user.role] || [];
  if (!state.tab) state.tab = tabs[0]?.[0];

  tabs.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = state.tab === key ? 'active' : '';
    b.onclick = () => { state.tab = key; render(); };
    navLinks.appendChild(b);
  });
}

// ---------- root render ----------
async function render() {
  renderNav();
  if (!state.user) return renderAuth();

  const scanParams = getScanParamsFromUrl();
  if (scanParams && (state.user.role === 'student' || state.user.role === 'worker')) {
    return renderScanResult(scanParams);
  }

  try {
    if (state.user.role === 'student' || state.user.role === 'worker') return renderStudentArea();
    if (state.user.role === 'lecturer') return renderLecturerArea();
    if (state.user.role === 'admin') return renderAdminArea();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// A student can mark attendance either by scanning in-app (camera + jsQR) or
// by opening the QR code's link with their phone's own Camera app — which
// lands them back here with ?s=&t=&e= in the URL. This handles that.
function getScanParamsFromUrl() {
  const params = new URLSearchParams(location.search);
  const sid = params.get('s');
  const tok = params.get('t');
  if (!sid || !tok) return null;
  const ts = params.get('e');
  return { sid: Number(sid), tok, ts: ts ? Number(ts) : undefined };
}

async function renderScanResult(params) {
  // Clear the query string immediately so re-rendering (tab clicks, etc.)
  // doesn't re-submit the same scan over and over.
  history.replaceState({}, '', location.pathname);
  app.innerHTML = `
    <div class="card center">
      <div style="font-size:2rem;">⏳</div>
      <h2>Verifying…</h2>
      <p class="muted">Marking your attendance…</p>
    </div>
  `;
  try {
    const result = await submitScan(params.sid, params.tok, params.ts);
    app.innerHTML = `
      <div class="card center">
        <div style="font-size:3rem;">✅</div>
        <h2>Attendance marked</h2>
        <p>${escapeHtml(result.course)}</p>
        <p class="muted">${new Date(result.time).toLocaleString()}</p>
        <button class="btn" id="backBtn">Done</button>
      </div>`;
    document.getElementById('backBtn').onclick = () => { state.tab = 'history'; render(); };
  } catch (e) {
    app.innerHTML = `
      <div class="card center">
        <div style="font-size:3rem;">⚠️</div>
        <h2>Couldn't mark attendance</h2>
        <p class="muted">${escapeHtml(e.message)}</p>
        <button class="btn" id="backBtn">OK</button>
      </div>`;
    document.getElementById('backBtn').onclick = () => { state.tab = 'courses'; render(); };
  }
}

// Shared by both the in-app camera scanner and the URL-link (native Camera app) path.
async function submitScan(sid, tok, ts) {
  const geo = await getGeoOrNull();
  return api('/attendance/scan', {
    method: 'POST',
    body: { sid, tok, ts, lat: geo?.lat, lng: geo?.lng },
  });
}

// ===================== AUTH =====================
function renderAuth() {
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:20px auto;">
      <div class="tabs">
        <button id="tabLogin" class="active">Log in</button>
        <button id="tabSignup">Create account</button>
      </div>
      <div id="authBody"></div>
    </div>
  `;
  document.getElementById('tabLogin').onclick = () => paintLogin(true);
  document.getElementById('tabSignup').onclick = () => paintLogin(false);
  paintLogin(true);

  function paintLogin(isLogin) {
    document.getElementById('tabLogin').classList.toggle('active', isLogin);
    document.getElementById('tabSignup').classList.toggle('active', !isLogin);
    const body = document.getElementById('authBody');
    if (isLogin) {
      body.innerHTML = `
        <h1>Welcome back</h1>
        <p class="subtitle">Log in to mark or manage attendance.</p>
        <label>Email</label><input id="email" type="email" placeholder="you@example.com" />
        <label>Password</label><input id="password" type="password" placeholder="••••••••" />
        <button class="btn" id="loginBtn">Log in</button>
      `;
      document.getElementById('loginBtn').onclick = async () => {
        try {
          const email = document.getElementById('email').value.trim();
          const password = document.getElementById('password').value;
          const data = await api('/auth/login', { method: 'POST', body: { email, password } });
          setSession(data.token, data.user);
          state.tab = null;
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    } else {
      body.innerHTML = `
        <h1>Create your account</h1>
        <p class="subtitle">Students &amp; workers scan to mark attendance. Lecturers/admins generate the QR code.</p>
        <label>I am a</label>
        <select id="role">
          <option value="student">Student</option>
          <option value="worker">Worker</option>
          <option value="lecturer">Lecturer / Supervisor</option>
          <option value="admin">Administrator</option>
        </select>
        <label>Full name</label><input id="fullName" placeholder="Jane Doe" />
        <label>Matriculation / Staff ID</label><input id="idNumber" placeholder="e.g. CSC/19/1234" />
        <label>Department</label><input id="department" placeholder="Computer Science" />
        <label>Email</label><input id="email" type="email" placeholder="you@example.com" />
        <label>Password</label><input id="password" type="password" placeholder="Choose a password" />
        <button class="btn" id="signupBtn">Create account</button>
      `;
      document.getElementById('signupBtn').onclick = async () => {
        try {
          const body = {
            role: document.getElementById('role').value,
            fullName: document.getElementById('fullName').value.trim(),
            idNumber: document.getElementById('idNumber').value.trim(),
            department: document.getElementById('department').value.trim(),
            email: document.getElementById('email').value.trim(),
            password: document.getElementById('password').value,
          };
          if (!body.fullName || !body.idNumber || !body.email || !body.password) {
            return toast('Please fill in all fields', 'err');
          }
          const data = await api('/auth/signup', { method: 'POST', body });
          setSession(data.token, data.user);
          state.tab = null;
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    }
  }
}

// ===================== STUDENT / WORKER =====================
async function renderStudentArea() {
  if (state.tab === 'courses') return renderStudentCourses();
  if (state.tab === 'scan') return renderScanner();
  if (state.tab === 'history') return renderHistory();
}

async function renderStudentCourses() {
  app.innerHTML = `<h1>Courses</h1><p class="subtitle">Enroll and upload a clear photo of yourself — this is what your lecturer or admin will see next to your name after you scan in, so they can quickly confirm it's really you.</p><div id="list" class="card"><div class="empty">Loading…</div></div>`;
  const [all, mine] = await Promise.all([api('/courses'), api('/students/me/courses')]);
  const mineIds = new Set(mine.map((c) => c.id));
  const list = document.getElementById('list');
  if (!all.length) return (list.innerHTML = `<div class="empty">No courses available yet.</div>`);

  list.innerHTML = '';
  all.forEach((c) => {
    const enrolled = mineIds.has(c.id);
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div style="flex:1">
        <strong>${escapeHtml(c.code)}</strong> — ${escapeHtml(c.title)}
        <div class="muted">Lecturer: ${escapeHtml(c.lecturer_name)}</div>
      </div>
      ${enrolled ? '<span class="badge ok">Enrolled</span>' : `<button class="btn small" data-id="${c.id}">Enroll</button>`}
    `;
    list.appendChild(row);
    if (!enrolled) {
      row.querySelector('button').onclick = () => openEnrollModal(c);
    }
  });
}

function openEnrollModal(course) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.style.cssText = 'position:fixed;inset:0;margin:auto;max-width:420px;max-height:90vh;overflow:auto;z-index:200;';
  wrap.innerHTML = `
    <h2>Enroll in ${escapeHtml(course.code)}</h2>
    <p class="muted">Upload a clear, front-facing photo. It will be shown to your lecturer alongside your attendance record.</p>
    <div class="photo-picker">
      <img id="photoPreview" src="https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(state.user.fullName)}" />
      <input id="photoInput" type="file" accept="image/*" capture="user" />
    </div>
    <div class="row" style="margin-top:20px;">
      <button class="btn secondary" id="cancelBtn">Cancel</button>
      <button class="btn" id="enrollBtn">Enroll</button>
    </div>
  `;
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:199;';
  document.body.append(backdrop, wrap);

  const close = () => { backdrop.remove(); wrap.remove(); };
  backdrop.onclick = close;
  wrap.querySelector('#cancelBtn').onclick = close;

  const input = wrap.querySelector('#photoInput');
  const preview = wrap.querySelector('#photoPreview');
  input.onchange = () => {
    if (input.files[0]) preview.src = URL.createObjectURL(input.files[0]);
  };

  wrap.querySelector('#enrollBtn').onclick = async () => {
    if (!input.files[0]) return toast('Please add a photo to continue', 'err');
    try {
      const form = new FormData();
      form.append('photo', input.files[0]);
      await api(`/courses/${course.id}/enroll`, { method: 'POST', body: form, isForm: true });
      toast('Enrolled! Your photo is on file for identification.', 'ok');
      close();
      renderStudentCourses();
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function renderScanner() {
  app.innerHTML = `
    <h1>Scan session QR code</h1>
    <p class="subtitle">Point your camera at the code your lecturer is displaying.</p>
    <div class="scanner-wrap">
      <video id="video" playsinline muted></video>
      <div class="scanner-frame"></div>
    </div>
    <div id="scanStatus" class="center muted" style="margin-top:14px;">Requesting camera…</div>
    <p class="muted center" style="margin-top:18px;">Camera not working here? You can also just open your phone's regular <strong>Camera app</strong> and point it at the same QR code — it'll open a link that marks your attendance automatically.</p>
  `;
  const video = document.getElementById('video');
  const statusEl = document.getElementById('scanStatus');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let stream, raf, locked = false;

  if (typeof jsQR !== 'function') {
    statusEl.textContent = 'The QR scanning library failed to load — check your internet connection and reload the page.';
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    await video.play();
    statusEl.textContent = 'Scanning…';
    tick();
  } catch (e) {
    statusEl.textContent = 'Camera access denied. Please allow camera permission and reload.';
    return;
  }

  function tick() {
    try {
      if (video.readyState === video.HAVE_ENOUGH_DATA && !locked) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code) handleCode(code.data);
      }
    } catch (err) {
      console.error('Scan loop error:', err);
      statusEl.textContent = 'Something went wrong while scanning — reload the page to try again.';
      return; // stop the loop instead of failing silently forever
    }
    raf = requestAnimationFrame(tick);
  }

  async function handleCode(text) {
    let sid, tok, ts;
    try {
      // Preferred: a full scannable URL like https://yourapp/?s=..&t=..&e=..
      const url = new URL(text);
      sid = Number(url.searchParams.get('s'));
      tok = url.searchParams.get('t');
      const tsParam = url.searchParams.get('e');
      ts = tsParam ? Number(tsParam) : undefined;
    } catch {
      // Fallback: older raw-JSON payload
      try {
        const payload = JSON.parse(text);
        sid = payload.sid; tok = payload.tok; ts = payload.ts;
      } catch { return; }
    }
    if (!sid || !tok) return;
    locked = true;
    statusEl.textContent = 'Verifying…';
    try {
      const result = await submitScan(sid, tok, ts);
      stopCamera();
      app.innerHTML = `
        <div class="card center">
          <div style="font-size:3rem;">✅</div>
          <h2>Attendance marked</h2>
          <p>${escapeHtml(result.course)}</p>
          <p class="muted">${new Date(result.time).toLocaleString()}</p>
          <button class="btn" id="backBtn">Done</button>
        </div>`;
      document.getElementById('backBtn').onclick = () => { state.tab = 'history'; render(); };
    } catch (e) {
      toast(e.message, 'err');
      statusEl.textContent = 'Scanning…';
      setTimeout(() => (locked = false), 1500);
    }
  }

  function stopCamera() {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
  }

  // stop camera if user navigates away
  window.addEventListener('hashchange', stopCamera, { once: true });
}

function getGeoOrNull() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 4000 }
    );
  });
}

async function renderHistory() {
  app.innerHTML = `<h1>My attendance history</h1><div id="list" class="card"><div class="empty">Loading…</div></div>`;
  const rows = await api('/students/me/attendance');
  const list = document.getElementById('list');
  if (!rows.length) return (list.innerHTML = `<div class="empty">No attendance recorded yet.</div>`);
  list.innerHTML = rows
    .map(
      (r) => `<div class="list-item">
        <div style="flex:1"><strong>${escapeHtml(r.code)}</strong> — ${escapeHtml(r.title)}</div>
        <div class="muted">${new Date(r.scanned_at + 'Z').toLocaleString()}</div>
      </div>`
    )
    .join('');
}

// ===================== LECTURER =====================
async function renderLecturerArea() {
  if (state.tab === 'courses') return renderLecturerCourses();
  if (state.tab === 'session') return renderLecturerSession();
  if (state.tab === 'reports') return renderLecturerReports();
}

async function renderLecturerCourses() {
  app.innerHTML = `
    <h1>My courses</h1>
    <div class="card">
      <h2>Create a course</h2>
      <div class="row">
        <div><label>Code</label><input id="code" placeholder="CSC 401" /></div>
        <div><label>Title</label><input id="title" placeholder="Software Engineering" /></div>
      </div>
      <button class="btn" id="createBtn">Create course</button>
    </div>
    <div id="list"></div>
  `;
  document.getElementById('createBtn').onclick = async () => {
    try {
      const code = document.getElementById('code').value.trim();
      const title = document.getElementById('title').value.trim();
      if (!code || !title) return toast('Enter course code and title', 'err');
      await api('/courses', { method: 'POST', body: { code, title } });
      toast('Course created', 'ok');
      renderLecturerCourses();
    } catch (e) { toast(e.message, 'err'); }
  };

  const courses = await api('/courses');
  const list = document.getElementById('list');
  if (!courses.length) return (list.innerHTML = `<div class="card empty">No courses yet — create one above.</div>`);

  for (const c of courses) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h2>${escapeHtml(c.code)} — ${escapeHtml(c.title)}</h2>
      <div class="grid-photos" id="roster-${c.id}"><div class="empty">Loading roster…</div></div>
    `;
    list.appendChild(card);
    api(`/courses/${c.id}/roster`).then((roster) => {
      const grid = document.getElementById(`roster-${c.id}`);
      if (!roster.length) return (grid.innerHTML = `<div class="empty">No students enrolled yet.</div>`);
      grid.innerHTML = roster
        .map(
          (s) => `<figure>
            <img src="${s.photoUrl || placeholderAvatar(s.fullName)}" alt="${escapeHtml(s.fullName)}" />
            <figcaption>${escapeHtml(s.fullName)}<br/><small>${escapeHtml(s.idNumber)}</small></figcaption>
          </figure>`
        )
        .join('');
    });
  }
}

let sessionPoll = null;

async function renderLecturerSession() {
  clearInterval(sessionPoll);
  const courses = await api('/courses');
  if (!courses.length) {
    app.innerHTML = `<h1>Live session</h1><div class="card empty">Create a course first, in the Courses tab.</div>`;
    return;
  }
  app.innerHTML = `
    <h1>Start a session</h1>
    <p class="subtitle">Generates a QR code that refreshes every 15 seconds so it can't be screenshotted and reused.</p>
    <div class="card" id="setupCard">
      <label>Course</label>
      <select id="courseSel">${courses.map((c) => `<option value="${c.id}">${escapeHtml(c.code)} — ${escapeHtml(c.title)}</option>`).join('')}</select>
      <label>Session length (minutes)</label>
      <input id="duration" type="number" value="15" min="1" />
      <label><input type="checkbox" id="useGeo" style="width:auto;display:inline-block;margin-right:8px;" />Restrict to my current location (geofence)</label>
      <div class="row" id="radiusRow" style="display:none;">
        <div><label>Radius (metres)</label><input id="radius" type="number" value="50" /></div>
      </div>
      <button class="btn" id="startBtn">Generate QR code</button>
    </div>
    <div id="liveArea"></div>
  `;
  document.getElementById('useGeo').onchange = (e) => {
    document.getElementById('radiusRow').style.display = e.target.checked ? 'flex' : 'none';
  };
  document.getElementById('startBtn').onclick = async () => {
    try {
      const courseId = Number(document.getElementById('courseSel').value);
      const durationMinutes = Number(document.getElementById('duration').value) || 15;
      let lat = null, lng = null, radiusM = null;
      if (document.getElementById('useGeo').checked) {
        const geo = await getGeoOrNull();
        if (!geo) return toast('Could not get your location', 'err');
        lat = geo.lat; lng = geo.lng;
        radiusM = Number(document.getElementById('radius').value) || 50;
      }
      const session = await api('/sessions', { method: 'POST', body: { courseId, durationMinutes, lat, lng, radiusM } });
      const course = courses.find((c) => c.id === courseId);
      startLiveSession(session, course);
    } catch (e) { toast(e.message, 'err'); }
  };
}

function startLiveSession(session, course) {
  document.getElementById('setupCard').classList.add('hidden');
  const live = document.getElementById('liveArea');
  live.innerHTML = `
    <div class="card center">
      <h2>${escapeHtml(course.code)} — ${escapeHtml(course.title)}</h2>
      <div class="qr-wrap">
        <div id="qrCanvasTarget"></div>
        <div class="countdown" id="refreshCountdown">--</div>
        <div class="countdown-label">seconds until code refreshes</div>
      </div>
      <p class="muted center" style="font-size:0.8rem;">Students can scan this with the app's Scan tab, their phone's regular Camera app, or just tap/type the link below.</p>
      <div class="row" style="margin-top:10px;">
        <input id="directLinkInput" readonly style="font-size:0.75rem;text-align:center;" />
        <button class="btn small secondary" id="copyLinkBtn" style="margin-top:0;">Copy link</button>
      </div>
      <p class="muted" id="sessionCountdown"></p>
      <button class="btn danger" id="endBtn">End session</button>
    </div>
    <div class="card">
      <h2>Live attendance <span class="badge ok" id="scanCount">0</span></h2>
      <div id="liveList" class="stack"><div class="empty">Waiting for scans…</div></div>
    </div>
  `;
  const qrTarget = document.getElementById('qrCanvasTarget');
  // width/height are generous, and CorrectLevel.L keeps the code as visually
  // simple as possible — both make it much easier for a phone camera to read
  // when it's photographing another screen (glare, slight blur, etc.).
  const qr = new QRCode(qrTarget, { text: ' ', width: 280, height: 280, correctLevel: QRCode.CorrectLevel.L });

  async function refreshQr() {
    try {
      const data = await api(`/sessions/${session.id}/qr-payload`);
      const obj = JSON.parse(data.payload);
      // Encode a real, clickable link — so students can scan it with their
      // phone's own Camera app, with no dependency on this page's JS at all.
      // Short param names (s/t/e) keep the URL — and so the QR code — as
      // small and easy to scan as possible.
      const scanUrl = `${window.location.origin}/?s=${obj.sid}&t=${encodeURIComponent(obj.tok)}&e=${obj.ts}`;
      qr.clear();
      qr.makeCode(scanUrl);
      const linkInput = document.getElementById('directLinkInput');
      if (linkInput) linkInput.value = scanUrl;
      let secs = data.refreshInSec;
      document.getElementById('refreshCountdown').textContent = secs;
      document.getElementById('sessionCountdown').textContent =
        `Session ends in ${Math.floor(data.sessionSecondsLeft / 60)}m ${data.sessionSecondsLeft % 60}s`;
      clearInterval(refreshQr._tick);
      refreshQr._tick = setInterval(() => {
        secs -= 1;
        document.getElementById('refreshCountdown').textContent = Math.max(secs, 0);
        if (secs <= 0) clearInterval(refreshQr._tick);
      }, 1000);
    } catch (e) {
      clearInterval(sessionPoll);
      live.innerHTML = `<div class="card empty">${escapeHtml(e.message)}</div>`;
    }
  }
  refreshQr();
  const qrInterval = setInterval(refreshQr, 15000);

  document.getElementById('copyLinkBtn').onclick = async () => {
    const input = document.getElementById('directLinkInput');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Link copied — share it with your students', 'ok');
    } catch {
      toast('Could not copy automatically — select the text and copy manually', 'err');
    }
  };

  async function refreshList() {
    const rows = await api(`/sessions/${session.id}/attendance`);
    document.getElementById('scanCount').textContent = rows.length;
    const listEl = document.getElementById('liveList');
    if (!rows.length) return (listEl.innerHTML = `<div class="empty">Waiting for scans…</div>`);
    listEl.innerHTML = rows
      .map(
        (r) => `<div class="list-item">
          <img class="avatar" src="${r.photoUrl || placeholderAvatar(r.fullName)}" />
          <div style="flex:1"><strong>${escapeHtml(r.fullName)}</strong><div class="muted">${escapeHtml(r.idNumber)}</div></div>
          <div class="muted">${new Date(r.scannedAt + 'Z').toLocaleTimeString()}</div>
        </div>`
      )
      .join('');
  }
  refreshList();
  sessionPoll = setInterval(refreshList, 3000);

  document.getElementById('endBtn').onclick = async () => {
    await api(`/sessions/${session.id}/end`, { method: 'POST' });
    clearInterval(qrInterval);
    clearInterval(refreshQr._tick);
    clearInterval(sessionPoll);
    toast('Session ended', 'ok');
    renderLecturerSession();
  };
}

async function renderLecturerReports() {
  const courses = await api('/courses');
  app.innerHTML = `
    <h1>Reports</h1>
    <p class="subtitle">Export attendance as CSV, or use your browser's Print → Save as PDF on this page for a PDF copy.</p>
    <div id="list"></div>
  `;
  const list = document.getElementById('list');
  if (!courses.length) return (list.innerHTML = `<div class="card empty">No courses yet.</div>`);
  list.innerHTML = courses
    .map(
      (c) => `<div class="card">
        <div class="list-item">
          <div style="flex:1"><strong>${escapeHtml(c.code)}</strong> — ${escapeHtml(c.title)}</div>
          <a class="btn small" href="/api/courses/${c.id}/report.csv" target="_blank">Download CSV</a>
        </div>
      </div>`
    )
    .join('');
}

// ===================== ADMIN =====================
async function renderAdminArea() {
  const [overview, users] = await Promise.all([api('/admin/overview'), api('/admin/users')]);
  app.innerHTML = `
    <h1>Admin overview</h1>
    <div class="row-desktop">
      <div class="card center"><h2>${overview.users}</h2><p class="muted">Total users</p></div>
      <div class="card center"><h2>${overview.courses}</h2><p class="muted">Courses</p></div>
      <div class="card center"><h2>${overview.attendanceCount}</h2><p class="muted">Attendance records</p></div>
    </div>
    <div class="card">
      <h2>All users</h2>
      <div class="stack">
        ${users
          .map(
            (u) => `<div class="list-item">
              <div style="flex:1"><strong>${escapeHtml(u.full_name)}</strong> <span class="badge warn">${u.role}</span>
              <div class="muted">${escapeHtml(u.email)} · ${escapeHtml(u.id_number)}</div></div>
            </div>`
          )
          .join('')}
      </div>
    </div>
  `;
}

// ---------- utils ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function placeholderAvatar(name) {
  return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name || '?')}`;
}

render();
