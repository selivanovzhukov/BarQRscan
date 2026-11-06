const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const RESULTS_FILE = path.join(ROOT, 'test-results.json');

const clients = new Set();
let currentTunnelUrl = null;
let collectedResults = {
  scans: [],
  logs: [],
  sessions: []
};

if (fs.existsSync(RESULTS_FILE)) {
  try {
    collectedResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch (e) {}
}

function saveResults() {
  try {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(collectedResults, null, 2), 'utf8');
  } catch (e) {}
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // Прийом телеметрії та результатів сканування з телефона
  if (req.method === 'POST' && urlPath === '/__report') {
    let body = '';
    req.on('data', chunk => {
      if (body.length < 1e6) body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const timestamp = new Date().toISOString();
        const ua = req.headers['user-agent'] || 'unknown';

        if (payload.type === 'scan') {
          const entry = { timestamp, ua, ...payload.data };
          collectedResults.scans.push(entry);
          console.log(`[SCAN RESULT] [${entry.engine}] ${entry.value} (${entry.format}) - ${entry.elapsedMs}ms | ROI:${entry.roi} | Res:${entry.resolution}`);
        } else if (payload.type === 'log') {
          const entry = { timestamp, ua, ...payload.data };
          collectedResults.logs.push(entry);
          console.log(`[PHONE LOG] [${entry.level}] ${entry.message}`);
        } else if (payload.type === 'summary') {
          const entry = { timestamp, ua, ...payload.data };
          collectedResults.sessions.push(entry);
          console.log(`[PHONE SUMMARY] Received full session snapshot (${(payload.data.history || []).length} unique codes)`);
        }
        saveResults();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
    });
    return;
  }

  if (urlPath === '/__results') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(collectedResults, null, 2));
    return;
  }

  if (urlPath !== '/__live_reload') {
    console.log(`[HTTP] ${req.method} ${urlPath} (${req.headers['user-agent'] || 'unknown'})`);
  }

  // Endpoint to query current tunnel status
  if (urlPath === '/__tunnel_status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ tunnelUrl: currentTunnelUrl }));
    return;
  }

  // Live-reload SSE endpoint
  if (urlPath === '/__live_reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(content);
  });
});

// Відстеження змін у файлах для миттєвого оновлення на телефоні
let debounceTimer = null;
fs.watch(ROOT, { persistent: true }, (eventType, filename) => {
  if (
    !filename ||
    filename.endsWith('.md') ||
    filename.endsWith('.txt') ||
    filename.endsWith('.json') ||
    filename === 'server.js' ||
    filename.startsWith('.')
  ) {
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[LiveReload] File changed: ${filename} -> notifying ${clients.size} client(s)`);
    for (const client of clients) {
      client.write('data: reload\n\n');
    }
  }, 150);
});

function verifyTunnelUrl(url) {
  https.get(url, (res) => {
    let body = '';
    res.on('data', chunk => {
      if (body.length < 300) body += chunk.toString();
    });
    res.on('end', () => {
      const ok = res.statusCode === 200 && !body.includes('no tunnel');
      console.log(`[TUNNEL CHECK] ${url} -> HTTP ${res.statusCode} (${ok ? 'WORKING OK' : 'FAILED: ' + body.slice(0, 80)})`);
    });
  }).on('error', (err) => {
    console.log(`[TUNNEL CHECK ERROR] ${err.message}`);
  });
}

function startSshTunnel() {
  console.log('[TUNNEL] Starting localhost.run SSH tunnel...');
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-T',
    '-R', `80:127.0.0.1:${PORT}`,
    'nokey@localhost.run'
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const keepAlive = setInterval(() => {
    if (!ssh.killed && ssh.stdin.writable) {
      // keep stdin open
    }
  }, 30000);

  const handleOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9]+\.lhr\.life/i);
    if (match && match[0] !== currentTunnelUrl) {
      currentTunnelUrl = match[0];
      console.log(`\n========================================`);
      console.log(`[TUNNEL READY] ${currentTunnelUrl}`);
      console.log(`========================================\n`);
      setTimeout(() => verifyTunnelUrl(currentTunnelUrl), 1000);
    }
  };

  ssh.stdout.on('data', handleOutput);
  ssh.stderr.on('data', handleOutput);

  ssh.on('close', (code) => {
    clearInterval(keepAlive);
    console.log(`[TUNNEL] SSH process exited with code ${code}. Reconnecting in 2s...`);
    currentTunnelUrl = null;
    setTimeout(startSshTunnel, 2000);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
  startSshTunnel();
});
