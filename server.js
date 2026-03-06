#!/usr/bin/env node
/**
 * Trading Team Dashboard - API Server v2
 * Zero dependencies — uses only Node.js built-ins
 *
 * Endpoints:
 *   GET  /            — Dashboard UI
 *   GET  /api/data    — Aggregate agent, cron, alerts, watchlist, sources
 *   GET  /api/health  — Agent & gateway health check
 *   POST /api/exec    — Execute trading command
 *
 * Usage: node server.js [--port 3456]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3456');
const OPENCLAW_DIR = path.join(require('os').homedir(), '.openclaw');

// === File paths ===
const PATHS = {
  config: path.join(OPENCLAW_DIR, 'openclaw.json'),
  cronJobs: path.join(OPENCLAW_DIR, 'cron', 'jobs.json'),
  mainSessions: path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions', 'sessions.json'),
  kieekeeSessions: path.join(OPENCLAW_DIR, 'agents', 'kieekiee', 'sessions', 'sessions.json'),
  mainIdentity: path.join(OPENCLAW_DIR, 'workspace', 'IDENTITY.md'),
  kieekeeIdentity: path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'IDENTITY.md'),
  alerts: path.join(OPENCLAW_DIR, 'shared', 'config', 'alerts.json'),
  watchlist: path.join(OPENCLAW_DIR, 'shared', 'config', 'watchlist.json'),
  sources: path.join(OPENCLAW_DIR, 'shared', 'config', 'sources.json'),
};

// === Helpers ===
function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

function aggregateTokens(sessionsData) {
  if (!sessionsData) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, sessions: 0 };
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, total = 0, sessions = 0;
  for (const [, session] of Object.entries(sessionsData)) {
    if (session.inputTokens) input += session.inputTokens;
    if (session.outputTokens) output += session.outputTokens;
    if (session.cacheRead) cacheRead += session.cacheRead;
    if (session.cacheWrite) cacheWrite += session.cacheWrite;
    if (session.totalTokens) total += session.totalTokens;
    sessions++;
  }
  return { input, output, cacheRead, cacheWrite, total, sessions };
}

function getLastActivity(sessionsData) {
  if (!sessionsData) return null;
  let latest = 0;
  for (const [, session] of Object.entries(sessionsData)) {
    const ts = session.updatedAt || session.createdAt || 0;
    if (typeof ts === 'number' && ts > latest) latest = ts;
    if (typeof ts === 'string') {
      const d = new Date(ts).getTime();
      if (d > latest) latest = d;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

// Simple HTTPS GET (returns Promise)
function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Simple HTTP GET (returns Promise)
function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      resolve({ status: res.statusCode });
      res.resume();
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// === API: Aggregate all data ===
function getData() {
  const config = readJSON(PATHS.config);
  const cronJobs = readJSON(PATHS.cronJobs);
  const mainSessions = readJSON(PATHS.mainSessions);
  const kieekeeSessions = readJSON(PATHS.kieekeeSessions);
  const alerts = readJSON(PATHS.alerts);
  const watchlist = readJSON(PATHS.watchlist);
  const sources = readJSON(PATHS.sources);

  const agents = (config?.agents?.list || []).map(agent => {
    const isMain = agent.id === 'main';
    const sessions = isMain ? mainSessions : kieekeeSessions;
    const tokens = aggregateTokens(sessions);
    const identity = readFile(isMain ? PATHS.mainIdentity : PATHS.kieekeeIdentity);
    const model = agent.model || config?.agents?.defaults?.model?.primary || 'unknown';

    return {
      id: agent.id,
      name: agent.name || agent.id,
      model,
      workspace: agent.workspace || config?.agents?.defaults?.workspace,
      identity: identity.substring(0, 500),
      tokens,
      isMain,
      contextTokens: sessions ? Object.values(sessions).find(s => s.contextTokens)?.contextTokens : null,
      modelProvider: sessions ? Object.values(sessions).find(s => s.modelProvider)?.modelProvider : null,
      lastActivity: getLastActivity(sessions),
    };
  });

  const jobs = (cronJobs?.jobs || []).map(job => ({
    id: job.id,
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    agentId: job.agentId || 'main',
    schedule: job.schedule,
    lastRunAt: job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : null,
    lastStatus: job.state?.lastStatus || job.state?.lastRunStatus || null,
    lastDelivered: job.state?.lastDelivered || false,
    lastDeliveryStatus: job.state?.lastDeliveryStatus || null,
    nextRunAt: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
    deliveryAccountId: job.delivery?.accountId || null,
  }));

  return {
    timestamp: new Date().toISOString(),
    agents,
    cronJobs: jobs,
    alerts: alerts || { active: [], triggered: [], lastChecked: null },
    watchlist: watchlist || {},
    sources: sources || {},
    gateway: { port: config?.gateway?.port || 18789 },
  };
}

// === API: Health check ===
async function getHealth() {
  const config = readJSON(PATHS.config);
  const mainSessions = readJSON(PATHS.mainSessions);
  const kieekeeSessions = readJSON(PATHS.kieekeeSessions);
  const gatewayPort = config?.gateway?.port || 18789;

  // Check gateway
  const gwResult = await httpGet(`http://localhost:${gatewayPort}`);
  const gwOnline = !!gwResult;

  // Check Telegram bots
  const telegramAccounts = config?.channels?.telegram?.accounts || {};
  const botChecks = [];

  for (const [accountId, account] of Object.entries(telegramAccounts)) {
    if (account.botToken) {
      botChecks.push(
        httpsGet(`https://api.telegram.org/bot${account.botToken}/getMe`)
          .then(r => ({
            accountId,
            name: account.name || accountId,
            status: r?.ok ? 'online' : 'offline',
            bot: r?.ok ? `@${r.result.username}` : null,
          }))
      );
    }
  }

  const bots = await Promise.all(botChecks);

  return {
    timestamp: new Date().toISOString(),
    gateway: { status: gwOnline ? 'online' : 'offline', port: gatewayPort },
    agents: [
      {
        id: 'main',
        telegram: bots.find(b => b.accountId === 'default') || { status: 'unknown' },
        lastActivity: getLastActivity(mainSessions),
        sessionsActive: mainSessions ? Object.keys(mainSessions).length : 0,
      },
      {
        id: 'kieekiee',
        telegram: bots.find(b => b.accountId === 'kieekiee') || { status: 'unknown' },
        lastActivity: getLastActivity(kieekeeSessions),
        sessionsActive: kieekeeSessions ? Object.keys(kieekeeSessions).length : 0,
      }
    ]
  };
}

// === API: Execute command ===
function execCommand(agent, command) {
  const mainAgentDir = path.join(OPENCLAW_DIR, 'workspace', 'agents');
  const kieeTradeDir = path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'trading');

  const commands = {
    main: {
      prices: `node "${path.join(mainAgentDir, 'tradingTeam.js')}" prices`,
      news: `node "${path.join(mainAgentDir, 'tradingTeam.js')}" news`,
      schedule: `node "${path.join(mainAgentDir, 'tradingTeam.js')}" schedule`,
    },
    kieekiee: {
      news: `node "${path.join(kieeTradeDir, 'worker.js')}" news`,
      digest: `node "${path.join(kieeTradeDir, 'worker.js')}" digest`,
      breaking: `node "${path.join(kieeTradeDir, 'worker.js')}" breaking`,
      morning: `node "${path.join(kieeTradeDir, 'worker.js')}" morning`,
      afternoon: `node "${path.join(kieeTradeDir, 'worker.js')}" afternoon`,
    }
  };

  const cmd = commands[agent]?.[command];
  if (!cmd) return { error: `Unknown command: ${agent}/${command}` };

  try {
    const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', shell: true });
    return { success: true, output, agent, command };
  } catch (err) {
    return { error: err.message, stderr: err.stderr, agent, command };
  }
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Routes
  if (url.pathname === '/' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  else if (url.pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getData()));
  }
  else if (url.pathname === '/api/health' && req.method === 'GET') {
    const health = await getHealth();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(health));
  }
  else if (url.pathname === '/api/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agent, command } = JSON.parse(body);
        const result = execCommand(agent, command);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🏢 Trading Team Dashboard v2`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`  📂 ${OPENCLAW_DIR}`);
  console.log(`  ⏹  Ctrl+C to stop\n`);
});
