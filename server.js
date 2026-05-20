// server.js (双方向対応版 + Claude自動実行 + ロングポーリング)
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const GEMINI_TO_CLAUDE_FILE = join(__dirname, 'gemini_ctx.md');
const CLAUDE_TO_GEMINI_FILE = join(__dirname, 'claude_out.md');
const STATUS_FILE = join(__dirname, '.claude_status');
const PUSH_FILE = join(__dirname, '.claude_push');
const LOG_FILE = join(__dirname, 'server.log');
const LOG_OLD_FILE = join(__dirname, 'server.log.old');
const MAX_LOG_BYTES = 1024 * 1024; // 1MB
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5分

// ---- ログ（1MBでローテーション） ----
function log(...args) {
  const msg = `[${new Date().toLocaleString()}] ${args.join(' ')}\n`;
  process.stdout.write(msg);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      if (fs.existsSync(LOG_OLD_FILE)) fs.unlinkSync(LOG_OLD_FILE);
      fs.renameSync(LOG_FILE, LOG_OLD_FILE);
    }
    fs.appendFileSync(LOG_FILE, msg);
  } catch {}
}

// ---- macOS通知 ----
function notify(title, message) {
  try {
    execSync(`osascript -e 'display notification "${message.replace(/'/g, '')}" with title "${title}"'`);
  } catch {}
}

// ---- ロングポーリング（GM_xmlhttpRequestはCSPをバイパスできる） ----
const longPollClients = [];

function broadcastEvent(data) {
  log('[Event]', JSON.stringify(data));
  while (longPollClients.length > 0) {
    const client = longPollClients.shift();
    clearTimeout(client.timer);
    if (!client.sent) {
      client.sent = true;
      client.res.writeHead(200, { 'Content-Type': 'application/json' });
      client.res.end(JSON.stringify(data));
    }
  }
}

// ---- Claude実行 ----
function runClaude(prompt) {
  const currentStatus = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : 'idle';
  if (currentStatus === 'running') {
    log('[Claude] 既に実行中のため無視します');
    broadcastEvent({ type: 'claude_done', status: 'busy', text: '' });
    return;
  }
  fs.writeFileSync(STATUS_FILE, 'running', 'utf8');
  log('[Claude] 実行開始...');

  const claudeBin = process.env.CLAUDE_BIN || '/Users/masato/.nvm/versions/node/v22.17.0/bin/claude';
  const claude = spawn(claudeBin, [
    '-p', prompt,
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
    '--dangerously-skip-permissions',
  ], { env: process.env, cwd: __dirname });

  const timer = setTimeout(() => {
    claude.kill();
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    log('[Claude] タイムアウト（5分）で強制終了しました');
    notify('Claude Code', 'タイムアウト（5分）で終了しました');
    broadcastEvent({ type: 'claude_done', status: 'timeout', text: '' });
  }, CLAUDE_TIMEOUT_MS);

  let output = '';
  claude.stdout.on('data', (data) => {
    const chunk = data.toString();
    output += chunk;
    process.stdout.write(chunk);
    fs.appendFileSync(LOG_FILE, chunk);
  });
  claude.stderr.on('data', (data) => { const m = data.toString().trim(); if (m) log('[Claude stderr]', m); });
  claude.on('error', (err) => {
    clearTimeout(timer);
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    log('[Claude] 起動失敗:', err.message);
    broadcastEvent({ type: 'claude_done', status: 'error', text: '' });
  });
  claude.on('close', (code) => {
    clearTimeout(timer);
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    const result = output.trim();
    if (code === 0 && result) {
      fs.writeFileSync(CLAUDE_TO_GEMINI_FILE, output, 'utf8');
      log('\n' + '─'.repeat(40));
      notify('Claude Code', '完了しました');
      broadcastEvent({ type: 'claude_done', status: 'done', text: output });
    } else {
      log(`[Claude] 終了コード: ${code}`);
      broadcastEvent({ type: 'claude_done', status: 'error', text: '' });
    }
  });
}

// ---- tampermonkey_script.js の変更を監視 ----
const scriptPath = join(__dirname, 'tampermonkey_script.js');
let reloadTimer = null;
fs.watch(scriptPath, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    log('[Watch] tampermonkey_script.js が更新されました。クライアントに通知します。');
    broadcastEvent({ type: 'script_updated' });
  }, 300);
});

// ---- HTTPサーバー ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://gemini.google.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 【イベントストリーム】Tampermonkeyがロングポーリングで受信
  if (req.method === 'GET' && req.url === '/events') {
    const client = { res, sent: false };
    client.timer = setTimeout(() => {
      if (!client.sent) {
        client.sent = true;
        const idx = longPollClients.indexOf(client);
        if (idx !== -1) longPollClients.splice(idx, 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 25000);
    longPollClients.push(client);
    req.on('close', () => {
      client.sent = true;
      clearTimeout(client.timer);
      const idx = longPollClients.indexOf(client);
      if (idx !== -1) longPollClients.splice(idx, 1);
    });
  }

  // 【Gemini ➔ Claude】受信 → 即200返却 → バックグラウンドでClaude実行
  else if (req.method === 'POST' && req.url === '/') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const content = `### Gemini Context (${new Date().toLocaleString()})\n\n${data.text}\n`;
        fs.writeFileSync(GEMINI_TO_CLAUDE_FILE, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        runClaude(data.text);
        log('[Success] Geminiの指示を受信。Claudeを起動しました。');
      } catch { res.writeHead(400).end(); }
    });
  }

  // 【Claude ➔ Gemini】claude_out.md の内容を返す
  else if (req.method === 'GET' && req.url === '/') {
    try {
      const text = fs.existsSync(CLAUDE_TO_GEMINI_FILE)
        ? fs.readFileSync(CLAUDE_TO_GEMINI_FILE, 'utf8')
        : 'Claudeからの新しいデータはありません。';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch { res.writeHead(500).end(); }
  }

  // 【ステータス確認】後方互換用
  else if (req.method === 'GET' && req.url === '/status') {
    const status = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : 'idle';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status }));
  }

  // 【ターミナル → Gemini】プッシュ → ロングポーリングで即配信 + pending保存
  else if (req.method === 'POST' && req.url === '/push') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const ts = Date.now();
        fs.writeFileSync(PUSH_FILE, JSON.stringify({ text: data.text, ts }), 'utf8');
        broadcastEvent({ type: 'push', text: data.text, ts });
        log('[Push] Geminiへ送信:\n' + data.text.slice(0, 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ts }));
      } catch { res.writeHead(400).end(); }
    });
  }

  // 【ページロード時確認】未処理の pending push を返す
  else if (req.method === 'GET' && req.url === '/pending') {
    try {
      if (fs.existsSync(PUSH_FILE)) {
        const raw = fs.readFileSync(PUSH_FILE, 'utf8');
        const data = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending: true, text: data.text, ts: data.ts }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending: false }));
      }
    } catch { res.writeHead(500).end(); }
  }

  // 【処理済み確認】pending を削除（Tampermonkey が送信完了後に呼ぶ）
  else if (req.method === 'POST' && req.url === '/ack') {
    try {
      if (fs.existsSync(PUSH_FILE)) fs.unlinkSync(PUSH_FILE);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch { res.writeHead(500).end(); }
  }

  // 【スクリプト配信】mtimeをバージョンとして差し込んで返す
  else if (req.method === 'GET' && (req.url === '/tampermonkey_script.js' || req.url === '/tampermonkey_script.user.js')) {
    let content = fs.readFileSync(scriptPath, 'utf8');
    const version = Math.floor(fs.statSync(scriptPath).mtimeMs / 1000);
    content = content.replace(/(@version\s+)[\d.]+/, `$1${version}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(content);
  }

  else { res.writeHead(404).end(); }
});

server.listen(PORT, () => {
  log(`Dual-Sync Server running on http://localhost:${PORT} (long polling enabled)`);
});
