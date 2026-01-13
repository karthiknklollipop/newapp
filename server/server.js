
/**
 * ETG Realtime Server (server/server.js)
 * Node.js + Express + Socket.IO
 *
 * - Serves static HTML from ../public
 * - Demo auth endpoint used by Stage 1
 * - Trip APIs with in-memory store + JSON persistence
 * - Emits realtime events over Socket.IO
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch (e) {}
  return { trips: {}, users: {} };
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write data.json:', e.message);
  }
}

const store = readData();

// --- Express ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve static UI
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// --- Demo auth ---
function roleFromEmail(email) {
  const e = String(email || '').toLowerCase();
  if (e.includes('traveldesk')) return 'TRAVEL_DESK';
  if (e.includes('travel') && e.includes('desk')) return 'TRAVEL_DESK';
  if (e.includes('manager') || e.includes('rm') || e.includes('approver')) return 'MANAGER';
  if (e.includes('admin') || e.includes('super')) return 'SUPER_ADMIN';
  return 'EMPLOYEE';
}

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '').trim();
  const requestedRoleRaw = String(req.body?.role || '').trim().toUpperCase();
  const allowedRoles = new Set(['EMPLOYEE', 'MANAGER', 'TRAVEL_DESK', 'SUPER_ADMIN']);
  const requestedRole = allowedRoles.has(requestedRoleRaw) ? requestedRoleRaw : '';

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }
  if (!password) {
    return res.status(401).json({ error: 'Password is required (demo).' });
  }

  // Create/update user
  // Demo rule: if the UI sends a role, honor it. Otherwise infer from email.
  // (In a real app, role should come from an identity directory / RBAC store.)
  const role = requestedRole || store.users[email]?.role || roleFromEmail(email);
  const user = store.users[email] || { email, role, name: email.split('@')[0] };
  user.role = role;
  user.updatedAt = new Date().toISOString();
  store.users[email] = user;

  const token = crypto.randomBytes(16).toString('hex');
  // In a real app, you'd store sessions; for demo we accept any token.
  writeData(store);

  res.json({ token, user });
});

// --- Trip helpers ---
function normalizeTrip(t) {
  const id = String(t?.id || '').trim();
  if (!id) return null;
  const now = new Date().toISOString();
  const prev = store.trips[id] || {};
  return {
    ...prev,
    ...t,
    id,
    createdAt: prev.createdAt || t.createdAt || now,
    updatedAt: now,
  };
}

function listTrips() {
  return Object.keys(store.trips)
    .map((k) => store.trips[k])
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// --- API: trips ---
app.get('/api/trips', (req, res) => {
  res.json(listTrips());
});

// Get a single trip by id (used by Stage 6 to pull quotation/options)
app.get('/api/trips/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Trip id is required.' });
  const trip = store.trips[id];
  if (!trip) return res.status(404).json({ error: 'Trip not found.' });
  res.json(trip);
});

app.post('/api/trips', (req, res) => {
  const trip = req.body || {};
  const id = String(trip.id || crypto.randomUUID()).trim();
  const merged = normalizeTrip({ ...trip, id });
  if (!merged) return res.status(400).json({ error: 'Trip id is required.' });

  const existed = !!store.trips[id];
  store.trips[id] = merged;
  writeData(store);

  io.emit(existed ? 'trip:updated' : 'trip:created', merged);
  res.json(merged);
});

app.patch('/api/trips/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Trip id is required.' });

  const patch = req.body || {};
  const merged = normalizeTrip({ ...patch, id });
  if (!merged) return res.status(400).json({ error: 'Trip id is required.' });

  store.trips[id] = merged;
  writeData(store);

  io.emit('trip:updated', merged);
  res.json(merged);
});

app.post('/api/trips/bulk', (req, res) => {
  const trips = Array.isArray(req.body?.trips) ? req.body.trips : [];
  if (!trips.length) return res.json({ ok: true, upserted: 0 });

  let upserted = 0;
  const changed = [];

  for (const t of trips) {
    const id = String(t?.id || '').trim();
    if (!id) continue;
    const existed = !!store.trips[id];
    const merged = normalizeTrip(t);
    if (!merged) continue;

    store.trips[id] = merged;
    upserted += 1;
    changed.push({ existed, trip: merged });
  }

  writeData(store);

  // Emit in bulk to reduce noise
  const updatedTrips = changed.map((x) => x.trip);
  io.emit('trip:bulk', updatedTrips);

  res.json({ ok: true, upserted });
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Default route: open login page
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'Stage 1 (User log in Template).html'));
});

// --- Socket.IO ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

io.on('connection', (socket) => {
  socket.emit('hello', { ok: true, ts: Date.now() });
});

server.listen(PORT, () => {
  console.log(`ETG realtime server running on http://localhost:${PORT}`);
  console.log(`Open: http://localhost:${PORT}/ (Login)`);
});
