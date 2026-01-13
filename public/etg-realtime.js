
/**
 * ETG Realtime Bridge (public/etg-realtime.js)
 * Goal: make existing multi-HTML workflow behave like a realtime app WITHOUT rewriting each page.
 *
 * How it works:
 * 1) Connect to Socket.IO (same origin by default).
 * 2) Pull trips from server and mirror into the localStorage keys your pages already use.
 * 3) Monkey-patch localStorage.setItem to detect trip changes and push them back to server (debounced).
 * 4) Provide hooks used by some stages (e.g., window.etgSendQuotation).
 *
 * This is a pragmatic bridge for a demo. For production: replace localStorage with proper API calls per stage.
 */
(function () {
  const API_BASE = (window.ETG_API_BASE != null ? String(window.ETG_API_BASE) : '');
  const TOKEN_KEY = 'etg-token';

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  async function api(path, opts = {}) {
    const url = (API_BASE || '') + path;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // --- Socket.IO ---
  let socket = null;
  function connectSocket() {
    if (!window.io) return null;
    try {
      socket = window.io(API_BASE || undefined, {
        transports: ['websocket', 'polling']
      });
      socket.on('connect', () => {
        // optional: console.log('[ETG] socket connected', socket.id);
      });
      socket.on('trip:created', (trip) => {
        if (trip) mirrorTripsToLocal([trip], { mergeOnly: true });
      });
      socket.on('trip:updated', (trip) => {
        if (trip) mirrorTripsToLocal([trip], { mergeOnly: true });
      });
      socket.on('trip:bulk', (trips) => {
        if (Array.isArray(trips)) mirrorTripsToLocal(trips, { mergeOnly: true });
      });
      return socket;
    } catch (e) {
      // ignore
      return null;
    }
  }

  // --- Local mirroring helpers ---
  const SUPPRESS_FLAG = { on: false };

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
  }

  function readGlobalMap() {
    try { return safeJsonParse(localStorage.getItem('etg-trips-global') || '{}', {}) || {}; }
    catch (e) { return {}; }
  }
  function writeGlobalMap(map) {
    try { localStorage.setItem('etg-trips-global', JSON.stringify(map || {})); } catch (e) {}
  }

  // Stage3 expects etg-trips store with pending/completed arrays in many paths
  function readDeskStore() {
    try { return safeJsonParse(localStorage.getItem('etg-trips') || '{}', {}) || {}; }
    catch (e) { return {}; }
  }
  function writeDeskStore(store) {
    try { localStorage.setItem('etg-trips', JSON.stringify(store || {})); } catch (e) {}
  }

  function statusBucket(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('completed') || s.includes('final')) return 'completed';
    if (s.includes('approved')) return 'approved';
    if (s.includes('rejected')) return 'rejected';
    if (s.includes('policy')) return 'policy_violation';
    if (s.includes('manager')) return 'pending_manager';
    // default
    return 'pending';
  }

  function normalizeTrip(t) {
    if (!t) return null;
    const id = String(t.id || t.reqId || t.requestId || '').trim();
    if (!id) return null;
    const createdAt = t.createdAt || new Date().toISOString();
    return Object.assign({}, t, { id, createdAt, updatedAt: t.updatedAt || new Date().toISOString() });
  }

  function mirrorTripsToLocal(trips, { mergeOnly = false } = {}) {
    const list = (Array.isArray(trips) ? trips : []).map(normalizeTrip).filter(Boolean);
    if (!list.length) return;

    SUPPRESS_FLAG.on = true;
    try {
      // 1) global map
      const g = readGlobalMap();
      list.forEach((t) => { g[String(t.id)] = Object.assign({}, g[String(t.id)] || {}, t); });
      writeGlobalMap(g);

      // 2) desk store buckets
      const store = readDeskStore();
      // Ensure arrays exist
      const buckets = ['pending', 'pending_manager', 'approved', 'rejected', 'policy_violation', 'completed'];
      buckets.forEach((b) => { if (!Array.isArray(store[b])) store[b] = []; });

      // If not mergeOnly, rebuild buckets from global for consistency
      if (!mergeOnly) {
        buckets.forEach((b) => { store[b] = []; });
        Object.keys(g).forEach((k) => {
          const tr = g[k];
          const b = statusBucket(tr.status);
          store[b].push(tr);
        });
      } else {
        // mergeOnly: upsert changed trips into appropriate bucket and remove from others
        list.forEach((tr) => {
          const b = statusBucket(tr.status);
          buckets.forEach((bb) => {
            store[bb] = (store[bb] || []).filter((x) => String(x && x.id) !== String(tr.id));
          });
          store[b].unshift(tr);
        });
      }

      writeDeskStore(store);
    } finally {
      // small delay to avoid immediate sync loop
      setTimeout(() => { SUPPRESS_FLAG.on = false; }, 0);
    }
  }

  // --- Push local changes to server (debounced bulk upsert) ---
  let pushTimer = null;
  async function pushAllTripsToServer() {
    try {
      // Merge trips from BOTH stores:
      // 1) etg-trips-global (canonical map)
      // 2) etg-trips bucket store (what Stage3/4/5 often writes)
      const g = readGlobalMap();
      const mergedById = {};

      // from global
      Object.keys(g || {}).forEach((k) => {
        const t = g[k];
        if (t && t.id) mergedById[String(t.id)] = t;
      });

      // from desk buckets
      const desk = readDeskStore();
      if (desk && typeof desk === 'object') {
        Object.keys(desk).forEach((k) => {
          const v = desk[k];
          if (Array.isArray(v)) {
            v.forEach((t) => {
              if (t && t.id) {
                const id = String(t.id);
                mergedById[id] = Object.assign({}, mergedById[id] || {}, t);
              }
            });
          }
        });
      }

      // Also refresh our global map from this merge so future reads see quotationOptions, etc.
      SUPPRESS_FLAG.on = true;
      try {
        Object.keys(mergedById).forEach((id) => {
          g[id] = Object.assign({}, g[id] || {}, mergedById[id]);
        });
        writeGlobalMap(g);
      } finally {
        setTimeout(() => { SUPPRESS_FLAG.on = false; }, 0);
      }

      const trips = Object.keys(mergedById).map((k) => mergedById[k]).filter(Boolean);
      if (!trips.length) return;
      await api('/api/trips/bulk', { method: 'POST', body: JSON.stringify({ trips }) });
    } catch (e) {
      // If backend not reachable, stay offline silently.
      // console.warn('[ETG] push failed', e);
    }
  }

  function schedulePush() {
    if (SUPPRESS_FLAG.on) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushAllTripsToServer, 400);
  }

  // Monkey patch localStorage.setItem
  (function patchStorage() {
    try {
      const orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (key, value) {
        const k = String(key || '');
        const rv = orig(key, value);
        if (!SUPPRESS_FLAG.on) {
          if (k === 'etg-trips-global' || k === 'etg-trips' || k === 'etg-trips-by-id') {
            schedulePush();
          }
          if (k === 'etg-last-quotation-trip-id' || k === 'etg-selected-trip-id') {
            // no-op
          }
        }
        return rv;
      };
    } catch (e) {}
  })();

  // --- Hooks used by existing pages ---
  window.etgSendQuotation = async function ({ trip, emailHtml, options } = {}) {
    try {
      if (!trip || !trip.id) return;
      const id = String(trip.id);
      const patch = {
        status: 'Quotation Sent to User',
        quotationHtml: emailHtml || '',
        // structured options used by Stage 6
        quotationOptions: options || trip.quotationOptions || trip.optionsShared || trip.travelDeskOptions || null,
        quotationSentAt: new Date().toISOString()
      };
      const updated = await api('/api/trips/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      mirrorTripsToLocal([updated], { mergeOnly: true });
    } catch (e) {
      // fallback: still mirror locally so flow continues
      try {
        const g = readGlobalMap();
        if (trip && trip.id) {
          g[String(trip.id)] = Object.assign({}, g[String(trip.id)] || {}, trip, {
            status: 'Quotation Sent to User',
            quotationHtml: emailHtml || '',
            quotationOptions: options || trip.quotationOptions || trip.optionsShared || trip.travelDeskOptions || null,
            quotationSentAt: new Date().toISOString()
          });
          mirrorTripsToLocal([g[String(trip.id)]], { mergeOnly: true });
        }
      } catch (_) {}
    }
  };

  // Public API (optional)
  window.ETG = window.ETG || {};
  window.ETG.api = api;
  window.ETG.socket = socket;

  // Initial sync: pull trips from server and mirror locally
  async function initialSync() {
    try {
      const trips = await api('/api/trips', { method: 'GET' });
      if (Array.isArray(trips)) mirrorTripsToLocal(trips, { mergeOnly: false });
    } catch (e) {
      // backend not reachable -> offline mode
    }
  }

  connectSocket();
  initialSync();
})();
