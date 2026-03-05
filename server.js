#!/usr/bin/env node
/**
 * Trading Team Dashboard - API Server
 * Zero dependencies — uses only Node.js built-ins
 *
 * Usage: node server.js [--port 3456]
 */

const http = require('http');
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

// === API: Aggregate all data ===
function getData() {
  const config = readJSON(PATHS.config);
  const cronJobs = readJSON(PATHS.cronJobs);
  const mainSessions = readJSON(PATHS.mainSessions);
  const kieekeeSessions = readJSON(PATHS.kieekeeSessions);
  const alerts = readJSON(PATHS.alerts);
  const watchlist = readJSON(PATHS.watchlist);

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
    nextRunAt: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
    deliveryAccountId: job.delivery?.accountId || null,
  }));

  return {
    timestamp: new Date().toISOString(),
    agents,
    cronJobs: jobs,
    alerts: alerts || { active: [], triggered: [] },
    watchlist: watchlist || {},
    gateway: { port: config?.gateway?.port || 18789 },
  };
}

// === API: Execute command ===
function execCommand(agent, command) {
  const commands = {
    main: {
      prices: `cd "${path.join(OPENCLAW_DIR, 'workspace', 'agents')}" && node tradingTeam.js prices`,
      news: `cd "${path.join(OPENCLAW_DIR, 'workspace', 'agents')}" && node tradingTeam.js news`,
      schedule: `cd "${path.join(OPENCLAW_DIR, 'workspace', 'agents')}" && node tradingTeam.js schedule`,
    },
    kieekiee: {
      news: `cd "${path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'trading')}" && node worker.js news`,
      digest: `cd "${path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'trading')}" && node worker.js digest`,
      breaking: `cd "${path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'trading')}" && node worker.js breaking`,
      morning: `cd "${path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'trading')}" && node worker.js morning`,
      afternoon: `cd "${path.join(OPENCLAW_DIR, 'workspace-kieekiee', 'trading')}" && node worker.js afternoon`,
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
const server = http.createServer((req, res) => {
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
  console.log(`\n  🏢 Trading Team Dashboard`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`  📂 ${OPENCLAW_DIR}`);
  console.log(`  ⏹  Ctrl+C to stop\n`);
});
