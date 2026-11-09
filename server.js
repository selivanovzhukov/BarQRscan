const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const ROOT = __dirname;
const RESULTS_FILE = path.join(ROOT, 'test-results.json');
const LOG_FILE = path.join(ROOT, 'server.log');
const CERT_DIR = path.join(ROOT, '.cert');

const clients = new Set();
let currentTunnelUrl = null;
let collectedResults = {
  scans: [],
  logs: [],
  sessions: []
};

function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {}
}

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

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  return (
    candidates.find(ip => ip.startsWith('192.168.')) ||
    candidates.find(ip => ip.startsWith('10.')) ||
    candidates[0] ||
    '127.0.0.1'
  );
}

// Pure Node.js ASN.1 DER helpers for X.509v3 self-signed certificate generation
function derLen(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function derTlv(tag, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf]);
}
function derSeq(...items) {
  return derTlv(0x30, Buffer.concat(items));
}
function derSet(...items) {
  return derTlv(0x31, Buffer.concat(items));
}
function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v === 0) {
      bytes.push(0);
      continue;
    }
    const enc = [];
    while (v > 0) {
      enc.unshift(v & 0x7f);
      v >>= 7;
    }
    for (let j = 0; j < enc.length - 1; j++) enc[j] |= 0x80;
    bytes.push(...enc);
  }
  return derTlv(0x06, Buffer.from(bytes));
}
function derInt(bufOrNum) {
  let buf = typeof bufOrNum === 'number'
    ? Buffer.from([bufOrNum])
    : Buffer.from(bufOrNum);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return derTlv(0x02, buf);
}
function derUtf8(str) {
  return derTlv(0x0c, Buffer.from(str, 'utf8'));
}
function derUtcTime(date) {
  const pad = n => String(n).padStart(2, '0');
  const s =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return derTlv(0x17, Buffer.from(s, 'ascii'));
}
function derBitString(buf) {
  return derTlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}
function derOctetString(buf) {
  return derTlv(0x04, buf);
}

function generateSelfSignedCert(lanIp) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const algSha256Rsa = derSeq(derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));

  const name = derSeq(
    derSet(derSeq(derOid('2.5.4.10'), derUtf8('ScannerTestLab'))),
    derSet(derSeq(derOid('2.5.4.3'), derUtf8(lanIp)))
  );

  const now = new Date(Date.now() - 60000);
  const exp = new Date(Date.now() + 825 * 24 * 3600 * 1000);
  const validity = derSeq(derUtcTime(now), derUtcTime(exp));

  const ipBytes = Buffer.from(lanIp.split('.').map(Number));
  const loBytes = Buffer.from([127, 0, 0, 1]);
  const sanValue = derSeq(
    derTlv(0x87, ipBytes),
    derTlv(0x87, loBytes),
    derTlv(0x82, Buffer.from('localhost', 'ascii'))
  );

  const extBasicConstraints = derSeq(
    derOid('2.5.29.19'),
    Buffer.from([0x01, 0x01, 0xff]),
    derOctetString(derSeq(Buffer.from([0x01, 0x01, 0xff])))
  );
  const extSan = derSeq(
    derOid('2.5.29.17'),
    derOctetString(sanValue)
  );
  const extensions = derTlv(0xa3, derSeq(extBasicConstraints, extSan));

  const serial = crypto.randomBytes(12);
  serial[0] &= 0x7f;

  const tbs = derSeq(
    derTlv(0xa0, derInt(2)), // v3
    derInt(serial),
    algSha256Rsa,
    name,
    validity,
    name,
    spkiDer,
    extensions
  );

  const sig = crypto.sign('sha256', tbs, privateKey);
  const certDer = derSeq(tbs, algSha256Rsa, derBitString(sig));

  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  return { key: keyPem, cert: certPem };
}

function ensureLocalHttpsCert(lanIp) {
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const ipFile = path.join(CERT_DIR, 'ip.txt');

  if (
    fs.existsSync(keyPath) &&
    fs.existsSync(certPath) &&
    fs.existsSync(ipFile) &&
    fs.readFileSync(ipFile, 'utf8').trim() === lanIp
  ) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  }

  const creds = generateSelfSignedCert(lanIp);
  fs.writeFileSync(keyPath, creds.key, 'utf8');
  fs.writeFileSync(certPath, creds.cert, 'utf8');
  fs.writeFileSync(ipFile, lanIp, 'utf8');
  return creds;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.crt': 'application/x-x509-ca-cert'
};

function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];

  // Завантаження кореневого сертифіката (за бажанням для iOS/Android)
  if (urlPath === '/ca.crt') {
    const certPath = path.join(CERT_DIR, 'cert.pem');
    if (fs.existsSync(certPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="scanner-local-ca.crt"'
      });
      res.end(fs.readFileSync(certPath));
      return;
    }
  }

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
          logLine(`[SCAN RESULT] [${entry.engine}] ${entry.value} (${entry.format}) - ${entry.elapsedMs}ms | ROI:${entry.roi} | Res:${entry.resolution}`);
        } else if (payload.type === 'log') {
          const entry = { timestamp, ua, ...payload.data };
          collectedResults.logs.push(entry);
          logLine(`[PHONE LOG] [${entry.level}] ${entry.message}`);
        } else if (payload.type === 'summary') {
          const entry = { timestamp, ua, ...payload.data };
          collectedResults.sessions.push(entry);
          logLine(`[PHONE SUMMARY] Received full session snapshot (${(payload.data.history || []).length} unique codes)`);
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
    logLine(`[HTTP] ${req.method} ${urlPath} (${req.headers['user-agent'] || 'unknown'})`);
  }

  if (urlPath === '/go') {
    const lanIp = getLocalLanIp();
    const target = currentTunnelUrl || `https://${lanIp}:${HTTPS_PORT}`;
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (urlPath === '/__tunnel_status') {
    const lanIp = getLocalLanIp();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      lanHttpsUrl: `https://${lanIp}:${HTTPS_PORT}`,
      lanHttpUrl: `http://${lanIp}:${HTTP_PORT}`,
      lanGoUrl: `http://${lanIp}:${HTTP_PORT}/go`,
      tunnelUrl: currentTunnelUrl
    }));
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
}

// Відстеження змін у файлах для миттєвого оновлення на телефоні
let debounceTimer = null;
fs.watch(ROOT, { persistent: true }, (eventType, filename) => {
  if (
    !filename ||
    filename.endsWith('.md') ||
    filename.endsWith('.txt') ||
    filename.endsWith('.json') ||
    filename.endsWith('.log') ||
    filename.endsWith('.bat') ||
    filename === 'server.js' ||
    filename.startsWith('.')
  ) {
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    logLine(`[LiveReload] File changed: ${filename} -> notifying ${clients.size} client(s)`);
    for (const client of clients) {
      client.write('data: reload\n\n');
    }
  }, 150);
});

function startSshTunnel() {
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-T',
    '-R', `80:127.0.0.1:${HTTP_PORT}`,
    'nokey@localhost.run'
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const handleOutput = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9]+\.lhr\.life/i);
    if (match && match[0] !== currentTunnelUrl) {
      currentTunnelUrl = match[0];
      logLine(`[TUNNEL READY] ${currentTunnelUrl} (або відкривайте постійну адресу http://${lanIp}:${HTTP_PORT}/go)`);
    }
  };

  ssh.stdout.on('data', handleOutput);
  ssh.stderr.on('data', handleOutput);

  ssh.on('close', () => {
    currentTunnelUrl = null;
    setTimeout(startSshTunnel, 2000);
  });
}

const lanIp = getLocalLanIp();
const httpServer = http.createServer(handleRequest);

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  logLine(`============================================================`);
  logLine(`[HTTP]  Локально (ПК):          http://localhost:${HTTP_PORT}`);
  logLine(`[REDIRECT] Постійний редірект:  http://${lanIp}:${HTTP_PORT}/go`);
  startSshTunnel();
});

try {
  const credentials = ensureLocalHttpsCert(lanIp);
  const httpsServer = https.createServer(credentials, handleRequest);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    logLine(`[HTTPS] ПРЯМА ПОСТІЙНА АДРЕСА (Wi-Fi):`);
    logLine(`  👉  https://${lanIp}:${HTTPS_PORT}  👈 (НЕ ЗМІНЮЄТЬСЯ!)`);
    logLine(`============================================================`);
  });
} catch (err) {
  logLine(`[HTTPS ERROR] Не вдалося підняти локальний HTTPS: ${err.message}`);
}
