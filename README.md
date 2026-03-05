# Trading Team Dashboard

Dark Neon dashboard for monitoring OpenClaw trading agents.

## Features

- **Team Overview** — Agent cards showing model, role, status
- **Token Usage** — Progress bars per agent with cache stats
- **Cron Schedule** — Timeline of all scheduled jobs with status
- **Command Center** — Execute trading commands from the browser
- **Auto-refresh** — Updates every 30 seconds

## Quick Start

```bash
node server.js
# Open http://localhost:3456
```

Custom port:
```bash
node server.js --port 8080
```

## Requirements

- Node.js 18+
- OpenClaw installed at `~/.openclaw/`

## Architecture

```
server.js    — Zero-dependency Node.js HTTP server
index.html   — Single-file dashboard (HTML + CSS + JS)
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serve dashboard |
| GET | `/api/data` | Aggregate agent & cron data |
| POST | `/api/exec` | Execute trading command |

### Data Sources

Reads directly from OpenClaw config files:

- `~/.openclaw/openclaw.json` — Agent definitions
- `~/.openclaw/agents/*/sessions/sessions.json` — Token usage
- `~/.openclaw/cron/jobs.json` — Scheduled jobs
- `~/.openclaw/shared/config/alerts.json` — Price alerts
- `~/.openclaw/shared/config/watchlist.json` — Watchlist

## Available Commands

**Main Agent:**
- `prices` — Fetch stock prices (SET, US, Crypto)
- `news` — Fetch market news
- `schedule` — Show cron schedule

**Kieekiee Agent:**
- `news` — Top 10 news
- `digest` — Daily news digest
- `breaking` — Breaking news alerts
- `morning` — Morning report
- `afternoon` — Afternoon report

## License

MIT
