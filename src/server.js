const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  next();
});

// ── Body size limit (prevent large payload abuse) ─────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Simple rate limiter (no external deps) ────────────────────────────────────
const rateLimits = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const entry = rateLimits.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateLimits.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
// Clean up rate limit map every 5 minutes to avoid memory growth
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, v] of rateLimits) { if (v.start < cutoff) rateLimits.delete(k); }
}, 300000);

// ── Input validators ──────────────────────────────────────────────────────────
const SHA1_RE  = /^[a-f0-9]{40}$/i;
const SOURCE_RE = /^(radarr|sonarr)$/;

function isValidHash(h)     { return typeof h === 'string' && SHA1_RE.test(h); }
function isValidSourceId(id){ return Number.isInteger(id) && id > 0 && id < 1e9; }
function isValidSource(s)   { return SOURCE_RE.test(s); }

// ── Config ────────────────────────────────────────────────────────────────────
const cfg = {
  radarr:   { url: (process.env.RADARR_URL  || '').replace(/\/$/, ''), key: process.env.RADARR_API_KEY },
  sonarr:   { url: (process.env.SONARR_URL  || '').replace(/\/$/, ''), key: process.env.SONARR_API_KEY },
  qbit:     { url: (process.env.QBIT_URL    || '').replace(/\/$/, ''), user: process.env.QBIT_USER, pass: process.env.QBIT_PASS },
  jellyfin: { url: (process.env.JELLYFIN_URL|| '').replace(/\/$/, ''), key: process.env.JELLYFIN_API_KEY },
  plex:     { url: (process.env.PLEX_URL    || '').replace(/\/$/, ''), token: process.env.PLEX_TOKEN },
};

// Validate all configured URLs are http/https pointing at known hosts (no file://, etc.)
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
Object.entries(cfg).forEach(([svc, c]) => {
  if (c.url && !isSafeUrl(c.url)) {
    console.error(`[Config] Invalid URL for ${svc}: ${c.url} — disabling`);
    c.url = '';
  }
});

function arrHeaders(key) {
  return { 'X-Api-Key': key, 'Content-Type': 'application/json' };
}

// ── qBittorrent ───────────────────────────────────────────────────────────────
async function qbitLogin() {
  const res = await axios.post(
    `${cfg.qbit.url}/api/v2/auth/login`,
    `username=${encodeURIComponent(cfg.qbit.user)}&password=${encodeURIComponent(cfg.qbit.pass)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
  );
  return res.headers['set-cookie']?.[0];
}

async function getQbitTorrents(cookie) {
  const res = await axios.get(`${cfg.qbit.url}/api/v2/torrents/info`, {
    headers: { Cookie: cookie }, timeout: 10000
  });
  return Array.isArray(res.data) ? res.data : [];
}

// ── Torrent title matching ────────────────────────────────────────────────────
function extractTitleFromTorrentName(name) {
  if (!name) return '';
  let s = name.replace(/[._]/g, ' ').toLowerCase();
  s = s.replace(/\s+s\d{1,2}e\d{1,2}.*/i, '');
  s = s.replace(/\s+\d{4}\s.*/i, '');
  s = s.replace(/\s+(2160p|1080p|720p|480p|bluray|web|webrip|hdtv|dvd|remux|amzn|nf|hbo).*/i, '');
  return s.trim();
}

function findTorrents(torrents, itemTitle, itemYear) {
  if (!torrents.length || !itemTitle) return [];
  const cleanTitle = itemTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return torrents.filter(t => {
    const torrentClean = extractTitleFromTorrentName(t.name);
    const torrentCleanAlpha = torrentClean.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (torrentCleanAlpha === cleanTitle) return true;
    if (torrentCleanAlpha.startsWith(cleanTitle) || cleanTitle.startsWith(torrentCleanAlpha)) return true;
    if (itemYear && t.name && t.name.includes(String(itemYear)) && torrentCleanAlpha.includes(cleanTitle.split(' ')[0])) return true;
    return false;
  });
}

const SEEDING_STATES = new Set(['uploading','stalledUP','queuedUP','checkingUP','forcedUP','moving']);
function torrentStatus(t) {
  if (!t) return null;
  if (SEEDING_STATES.has(t.state)) return 'seeding';
  if (t.state === 'pausedUP' || t.state === 'stoppedUP') return 'stopped';
  if (t.state === 'downloading' || t.state === 'stalledDL') return 'downloading';
  return 'stopped';
}

// ── Jellyfin / Plex watched ───────────────────────────────────────────────────
async function getJellyfinWatched() {
  if (!cfg.jellyfin.url || !cfg.jellyfin.key) return new Set();
  try {
    const usersRes = await axios.get(`${cfg.jellyfin.url}/Users`, {
      headers: { 'X-Emby-Token': cfg.jellyfin.key }, timeout: 8000
    });
    const users = Array.isArray(usersRes.data) ? usersRes.data : [];
    const admin = users.find(u => u.Policy?.IsAdministrator) || users[0];
    if (!admin) return new Set();
    const itemsRes = await axios.get(`${cfg.jellyfin.url}/Users/${admin.Id}/Items`, {
      headers: { 'X-Emby-Token': cfg.jellyfin.key },
      params: { Recursive: true, IsPlayed: true, IncludeItemTypes: 'Movie,Series', Fields: 'Path', Limit: 5000 },
      timeout: 15000
    });
    const items = itemsRes.data?.Items || [];
    const watched = new Set();
    items.forEach(i => { if (i.Path) watched.add(i.Path); if (i.Name) watched.add(i.Name.toLowerCase()); });
    return watched;
  } catch (e) { console.error('[Jellyfin] error:', e.message); return new Set(); }
}

async function getPlexWatched() {
  if (!cfg.plex.url || !cfg.plex.token) return new Set();
  try {
    const libRes = await axios.get(`${cfg.plex.url}/library/sections`, {
      headers: { 'X-Plex-Token': cfg.plex.token, Accept: 'application/json' }, timeout: 8000
    });
    const sections = libRes.data?.MediaContainer?.Directory || [];
    const watched = new Set();
    for (const section of sections) {
      if (!['movie', 'show'].includes(section.type)) continue;
      try {
        const res = await axios.get(`${cfg.plex.url}/library/sections/${section.key}/all`, {
          headers: { 'X-Plex-Token': cfg.plex.token, Accept: 'application/json' },
          params: { viewCount: 1 }, timeout: 15000
        });
        const items = res.data?.MediaContainer?.Metadata || [];
        items.forEach(i => {
          if ((i.viewCount || 0) > 0) {
            if (i.title) watched.add(i.title.toLowerCase());
            const mediaPart = i.Media?.[0]?.Part?.[0]?.file;
            if (mediaPart) watched.add(path.dirname(mediaPart));
          }
        });
      } catch (e) { console.error('[Plex] section error:', e.message); }
    }
    return watched;
  } catch (e) { console.error('[Plex] error:', e.message); return new Set(); }
}

// ── Poster proxy — SSRF-safe ──────────────────────────────────────────────────
app.get('/api/poster', rateLimit(60000, 120), async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).end();
  try {
    // Parse and validate — must be http/https and must match a configured arr host exactly
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(403).end();
    const allowed = [cfg.radarr.url, cfg.sonarr.url].filter(Boolean).map(u => new URL(u));
    const ok = allowed.some(a => a.host === parsed.host && parsed.pathname.startsWith('/'));
    if (!ok) return res.status(403).end();
    const apiKey = cfg.radarr.url && new URL(cfg.radarr.url).host === parsed.host ? cfg.radarr.key : cfg.sonarr.key;
    const r = await axios.get(url, {
      responseType: 'stream', timeout: 8000,
      headers: { 'X-Api-Key': apiKey },
      maxRedirects: 0  // no redirects — prevent redirect-based SSRF
    });
    const ct = r.headers['content-type'] || '';
    if (!ct.startsWith('image/')) return res.status(400).end();  // only allow images
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    r.data.pipe(res);
  } catch { res.status(404).end(); }
});

// ── GET /api/library ─────────────────────────────────────────────────────── ─
app.get('/api/library', rateLimit(60000, 30), async (req, res) => {
  const results = [];
  const errors  = [];

  let qcookie = null, torrents = [], jellyfinWatched = new Set(), plexWatched = new Set();
  await Promise.all([
    (async () => {
      if (cfg.qbit.url) {
        try { qcookie = await qbitLogin(); torrents = await getQbitTorrents(qcookie); }
        catch (e) { errors.push(`qBittorrent: ${e.message}`); }
      }
    })(),
    (async () => { jellyfinWatched = await getJellyfinWatched(); })(),
    (async () => { plexWatched = await getPlexWatched(); })(),
  ]);

  console.log(`[qBit] ${torrents.length} torrents loaded`);

  function isWatched(title, itemPath) {
    const tl = (title || '').toLowerCase();
    return {
      jellyfin: jellyfinWatched.has(tl) || (itemPath && jellyfinWatched.has(itemPath)),
      plex:     plexWatched.has(tl)     || (itemPath && plexWatched.has(itemPath)),
    };
  }

  if (cfg.radarr.url && cfg.radarr.key) {
    try {
      const r = await axios.get(`${cfg.radarr.url}/api/v3/movie`, {
        headers: arrHeaders(cfg.radarr.key), timeout: 15000
      });
      const movies = Array.isArray(r.data) ? r.data : [];
      movies.forEach(m => {
        if (!m.hasFile) return;
        const matched = findTorrents(torrents, m.title, m.year);
        const torrent = matched.sort((a,b) => (b.ratio||0)-(a.ratio||0))[0] || null;
        const torrentHashes = matched.map(t => t.hash).filter(isValidHash);
        const posterPath = m.images?.find(i => i.coverType === 'poster')?.url;
        const poster = posterPath ? `${cfg.radarr.url}${posterPath.startsWith('/') ? '' : '/'}${posterPath}` : null;
        console.log(`[Match] "${m.title}" -> ${matched.length} torrent(s)`);
        results.push({
          id: `radarr-${m.id}`, sourceId: m.id, source: 'radarr', type: 'movie',
          title: m.title, year: m.year, quality: m.movieFile?.quality?.quality?.name || '—',
          size: m.sizeOnDisk, path: m.path, poster,
          ratio: torrent ? Math.round(torrent.ratio * 100) / 100 : null,
          torrentHashes, torrentStatus: torrentStatus(torrent),
          watched: isWatched(m.title, m.path),
        });
      });
    } catch (e) { console.error('[Radarr] error:', e.message); errors.push(`Radarr: ${e.message}`); }
  }

  if (cfg.sonarr.url && cfg.sonarr.key) {
    try {
      const r = await axios.get(`${cfg.sonarr.url}/api/v3/series`, {
        headers: arrHeaders(cfg.sonarr.key), timeout: 15000
      });
      const shows = Array.isArray(r.data) ? r.data : [];
      shows.forEach(s => {
        if (!s.statistics?.episodeFileCount) return;
        const matched = findTorrents(torrents, s.title, s.year);
        const torrentHashes = matched.map(t => t.hash).filter(isValidHash);
        const torrent = matched.sort((a,b) => (b.ratio||0)-(a.ratio||0))[0] || null;
        const posterPath = s.images?.find(i => i.coverType === 'poster')?.url;
        const poster = posterPath ? `${cfg.sonarr.url}${posterPath.startsWith('/') ? '' : '/'}${posterPath}` : null;
        console.log(`[Match] "${s.title}" -> ${matched.length} torrent(s)`);
        results.push({
          id: `sonarr-${s.id}`, sourceId: s.id, source: 'sonarr', type: 'show',
          title: s.title, year: s.year, quality: '—',
          size: s.statistics?.sizeOnDisk || 0, path: s.path, poster,
          seasons: s.statistics?.seasonCount, episodes: s.statistics?.episodeFileCount,
          ratio: torrent ? Math.round(torrent.ratio * 100) / 100 : null,
          torrentHashes, torrentStatus: torrentStatus(torrent),
          watched: isWatched(s.title, s.path),
        });
      });
    } catch (e) { console.error('[Sonarr] error:', e.message); errors.push(`Sonarr: ${e.message}`); }
  }

  res.json({ items: results, errors });
});

// ── POST /api/delete ──────────────────────────────────────────────────────────
app.post('/api/delete', rateLimit(60000, 20), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items provided' });
  if (items.length > 100) return res.status(400).json({ error: 'Too many items in one request' });

  const log = [];
  let qcookie = null;

  const ensureQbit = async () => {
    if (!qcookie && cfg.qbit.url) {
      try { qcookie = await qbitLogin(); }
      catch (e) { log.push({ step: 'qBittorrent login', ok: false, msg: e.message }); }
    }
  };

  for (const item of items) {
    // Strict validation of all client-supplied fields before using them
    if (!isValidSource(item.source))   { log.push({ step: 'Validation', ok: false, msg: `Invalid source: ${item.source}` }); continue; }
    if (!isValidSourceId(item.sourceId)) { log.push({ step: 'Validation', ok: false, msg: `Invalid sourceId` }); continue; }
    const hashes = (item.torrentHashes || []).filter(isValidHash);

    if (item.source === 'radarr' && cfg.radarr.url) {
      try {
        await axios.delete(
          `${cfg.radarr.url}/api/v3/movie/${item.sourceId}?deleteFiles=true&addImportExclusion=false`,
          { headers: arrHeaders(cfg.radarr.key), timeout: 15000 }
        );
        log.push({ step: `Radarr: removed "${item.title}" + files`, ok: true });
      } catch (e) { log.push({ step: `Radarr: remove "${item.title}"`, ok: false, msg: e.message }); }
    }

    if (item.source === 'sonarr' && cfg.sonarr.url) {
      try {
        await axios.delete(
          `${cfg.sonarr.url}/api/v3/series/${item.sourceId}?deleteFiles=true`,
          { headers: arrHeaders(cfg.sonarr.key), timeout: 15000 }
        );
        log.push({ step: `Sonarr: removed "${item.title}" + files`, ok: true });
      } catch (e) { log.push({ step: `Sonarr: remove "${item.title}"`, ok: false, msg: e.message }); }
    }

    if (cfg.qbit.url) {
      await ensureQbit();
      if (hashes.length && qcookie) {
        try {
          await axios.post(
            `${cfg.qbit.url}/api/v2/torrents/delete`,
            `hashes=${hashes.join('|')}&deleteFiles=true`,
            { headers: { Cookie: qcookie, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
          );
          log.push({ step: `qBittorrent: removed ${hashes.length} torrent(s) + files for "${item.title}"`, ok: true });
        } catch (e) {
          log.push({ step: `qBittorrent: remove "${item.title}"`, ok: false, msg: e.message });
        }
      } else if (!hashes.length) {
        log.push({ step: `qBittorrent: no torrents matched for "${item.title}" — skipped`, ok: true });
      }
    }
  }
  res.json({ ok: true, log });
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', rateLimit(60000, 10), async (req, res) => {
  const status = {};
  const check = async (name, fn) => { try { await fn(); status[name] = 'ok'; } catch { status[name] = 'error'; } };
  if (cfg.radarr.url)   await check('radarr',      () => axios.get(`${cfg.radarr.url}/api/v3/system/status`,  { headers: arrHeaders(cfg.radarr.key), timeout: 5000 }));
  else status.radarr = 'not configured';
  if (cfg.sonarr.url)   await check('sonarr',      () => axios.get(`${cfg.sonarr.url}/api/v3/system/status`,  { headers: arrHeaders(cfg.sonarr.key), timeout: 5000 }));
  else status.sonarr = 'not configured';
  if (cfg.qbit.url)     await check('qbittorrent', () => qbitLogin());
  else status.qbittorrent = 'not configured';
  if (cfg.jellyfin.url) await check('jellyfin',    () => axios.get(`${cfg.jellyfin.url}/System/Info`, { headers: { 'X-Emby-Token': cfg.jellyfin.key }, timeout: 5000 }));
  else status.jellyfin = 'not configured';
  if (cfg.plex.url)     await check('plex',        () => axios.get(`${cfg.plex.url}/identity`,        { headers: { 'X-Plex-Token': cfg.plex.token }, timeout: 5000 }));
  else status.plex = 'not configured';
  res.json(status);
});

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
// Bind to all interfaces — fine for local network, change to 127.0.0.1 if you want localhost only
app.listen(PORT, '0.0.0.0', () => console.log(`Cleanrr running on :${PORT}`));
