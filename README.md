# Cleanrr

**One-click deletion for your self-hosted media stack.**

Remove movies and TV shows from Radarr, Sonarr, qBittorrent, and disk — all at once, from a single web UI running in Docker.

![Cleanrr](https://img.shields.io/badge/version-1.0.0-e5484d?style=flat-square) ![Docker](https://img.shields.io/badge/docker-ready-0db7ed?style=flat-square&logo=docker&logoColor=white) ![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## The problem

Managing a self-hosted *arr stack means visiting four different apps every time you finish watching something — Radarr or Sonarr to remove the entry, qBittorrent to delete the torrent, and your file manager to clean up disk. Cleanrr does all of that in one click.

## Features

- Browse your full Radarr + Sonarr library in one place
- See **watched status** from Plex and Jellyfin side by side
- See **seeding ratio** per item — green ≥ 2.0, orange below 2.0
- See torrent **status** — Seeding, Stopped, or Downloading
- **One-click delete** — removes from Radarr/Sonarr, clears all matching torrents from qBittorrent, deletes files from disk
- **Bulk delete** — select multiple items and wipe them all at once
- **Select watched** — instantly selects everything you have already seen
- Sort by size, title, year, or ratio
- Filter by watched state
- Dark and light mode with system preference detection
- Poster art pulled from Radarr/Sonarr

## Stack support

| App | What happens on delete |
|-----|----------------------|
| Radarr | Entry removed + files deleted from disk |
| Sonarr | Series removed + files deleted from disk |
| qBittorrent | All matching torrents removed + files deleted from `/downloads` |
| Jellyfin | Watched status displayed (read-only) |
| Plex | Watched status displayed (read-only) |

---

## Quick start

### 1. Clone the repo

```bash
git clone https://github.com/yourusername/cleanrr.git
cd cleanrr
```

### 2. Create your compose file

```bash
cp docker-compose.example.yml docker-compose.yml
```

Then open `docker-compose.yml` and fill in your values. See the full configuration guide below.

### 3. Run it

```bash
docker compose up -d
```

Open `http://your-server-ip:3000` in your browser.

---

## Configuration guide

### Finding your server IP

If you are unsure of your server's local IP address run this on the server:

```bash
hostname -I | awk '{print $1}'
```

It will print something like `192.168.1.100`. Use that value everywhere below.

---

### Radarr

**API key:** Radarr → Settings → General → API Key

**Default port:** `7878`

| Your setup | URL to use |
|---|---|
| Radarr on same machine as Cleanrr | `http://192.168.1.100:7878` |
| Radarr in the same Docker Compose file | `http://radarr:7878` |
| Radarr behind a reverse proxy | `http://192.168.1.100:7878` (internal port, not your subdomain) |

```yaml
RADARR_URL: "http://192.168.1.100:7878"
RADARR_API_KEY: "your_api_key"
```

> If your reverse proxy puts authentication in front of Radarr (Authelia, Authentik, nginx basic auth), always use the internal IP and port directly — not the subdomain. Cleanrr authenticates via API key and does not handle proxy login pages.

---

### Sonarr

**API key:** Sonarr → Settings → General → API Key

**Default port:** `8989`

| Your setup | URL to use |
|---|---|
| Sonarr on same machine as Cleanrr | `http://192.168.1.100:8989` |
| Sonarr in the same Docker Compose file | `http://sonarr:8989` |
| Sonarr behind a reverse proxy | `http://192.168.1.100:8989` (internal port) |

```yaml
SONARR_URL: "http://192.168.1.100:8989"
SONARR_API_KEY: "your_api_key"
```

---

### qBittorrent

**Enable WebUI:** qBittorrent → Tools → Web UI → check "Enable Web User Interface"

**Default port:** `8080`

Use the same username and password you set in the WebUI settings.

| Your setup | URL to use |
|---|---|
| qBittorrent on same machine | `http://192.168.1.100:8080` |
| qBittorrent in the same Docker Compose file | `http://qbittorrent:8080` |

```yaml
QBIT_URL: "http://192.168.1.100:8080"
QBIT_USER: "admin"
QBIT_PASS: "your_password"
```

---

### Jellyfin (optional)

Cleanrr uses Jellyfin only to show which items you have watched. It never modifies anything in Jellyfin.

**API key:** Jellyfin → Dashboard → Advanced → API Keys → click the **+** button → give it any name → copy the key

**Default port:** `8096`

| Your setup | URL to use |
|---|---|
| Jellyfin on same machine as Cleanrr | `http://192.168.1.100:8096` |
| Jellyfin in the same Docker Compose file | `http://jellyfin:8096` |
| Jellyfin behind a reverse proxy | `http://192.168.1.100:8096` (internal port) |

```yaml
JELLYFIN_URL: "http://192.168.1.100:8096"
JELLYFIN_API_KEY: "your_api_key"
```

---

### Plex (optional)

Cleanrr uses Plex only to show which items you have watched. It never modifies anything in Plex.

**How to find your Plex token:**
1. Open Plex Web in your browser
2. Play any movie or episode
3. Click **···** → **Get Info** → **View XML**
4. Look in the URL bar for `X-Plex-Token=` — the value after the `=` is your token

**Default port:** `32400`

| Your setup | URL to use |
|---|---|
| Plex on same machine as Cleanrr | `http://192.168.1.100:32400` |
| Plex in the same Docker Compose file | `http://plex:32400` |
| Plex behind a reverse proxy | `http://192.168.1.100:32400` (internal port) |

```yaml
PLEX_URL: "http://192.168.1.100:32400"
PLEX_TOKEN: "your_plex_token"
```

---

### Docker networking

**Never use `localhost`** inside a Docker container — it refers to the container itself, not your host machine. Always use your server's LAN IP or a Docker service name.

If your *arr stack runs in a separate Docker Compose file with its own named network, you can connect Cleanrr to it by uncommenting the `networks` section in `docker-compose.yml`:

```yaml
services:
  cleanrr:
    ...
    networks:
      - arr-network

networks:
  arr-network:
    external: true
```

Run `docker network ls` to see your existing network names.

---

## Security

Designed for **local network use only** — do not expose port 3000 to the internet.

Built-in hardening:
- Security headers on every response (`X-Frame-Options`, `CSP`, `X-Content-Type-Options`)
- Rate limiting on all endpoints (no external dependencies)
- Input validation — sourceId must be a positive integer, torrent hashes validated as SHA1
- Batch delete capped at 100 items per request
- Poster proxy is SSRF-safe — validates host, blocks redirects, only serves image content
- All outbound requests have timeouts
- XSS-safe frontend — API data inserted via `textContent`, never raw `innerHTML`
- Request body limited to 64kb

---

## How torrent matching works

qBittorrent stores files in a flat `/downloads` folder using release names like `House.of.Guinness.S01E01.2160p.WEB.h265-BETTY`. These never match the library paths Sonarr/Radarr use (`/tv/House of Guinness/`).

Cleanrr extracts the clean title from the release name by stripping resolution, source tags, season/episode markers, and group names — then matches against the Radarr/Sonarr title. For TV shows it finds **all** per-episode torrents and deletes them together in one batch call using the qBittorrent hash API.

---

## Requirements

- Docker + Docker Compose
- Radarr and/or Sonarr (v3 API)
- qBittorrent with WebUI enabled
- Jellyfin and/or Plex (optional)

---

## License

MIT
