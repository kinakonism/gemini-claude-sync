// server.js (双方向対応版 + Claude自動実行 + WebSocket)
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, execSync } from 'child_process';
import { WebSocketServer } from 'ws';

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

// ---- WebSocket ----
const httpServer = http.createServer(handleRequest);
const wss = new WebSocketServer({ server: httpServer });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', () => log('[WS] クライアント接続'));

// ---- Claude実行 ----
function runClaude(prompt) {
  fs.writeFileSync(STATUS_FILE, 'running', 'utf8');
  log('[Claude] 実行開始...');

  const claudeBin = process.env.CLAUDE_BIN || '/Users/masato/.nvm/versions/node/v22.17.0/bin/claude';
  const claude = spawn(claudeBin, [
    '-p', prompt,
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
    '--dangerously-skip-permissions',
  ], {
    env: process.env,
    cwd: __dirname,
  });

  const timer = setTimeout(() => {
    claude.kill();
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    log('[Claude] タイムアウト（5分）で強制終了しました');
    notify('Claude Code', 'タイムアウト（5分）で終了しました');
    broadcast({ type: 'claude_done', status: 'timeout', text: '' });
  }, CLAUDE_TIMEOUT_MS);

  let output = '';

  // リアルタイムストリーミング
  claude.stdout.on('data', (data) => {
    const chunk = data.toString();
    output += chunk;
    process.stdout.write(chunk); // ターミナルにリアルタイム表示
    fs.appendFileSync(LOG_FILE, chunk);
  });

  claude.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) log('[Claude stderr]', msg);
  });

  claude.on('error', (err) => {
    clearTimeout(timer);
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    log('[Claude] 起動失敗:', err.message);
    broadcast({ type: 'claude_done', status: 'error', text: '' });
  });

  claude.on('close', (code) => {
    clearTimeout(timer);
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    const result = output.trim();
    if (code === 0 && result) {
      fs.writeFileSync(CLAUDE_TO_GEMINI_FILE, output, 'utf8');
      log('\n' + '─'.repeat(40));
      notify('Claude Code', '完了しました');
      broadcast({ type: 'claude_done', status: 'done', text: output });
    } else {
      log(`[Claude] 終了コード: ${code}`);
      broadcast({ type: 'claude_done', status: 'error', text: '' });
    }
  });
}

// ---- HTTPリクエスト処理 ----
function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://gemini.google.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 【Gemini ➔ Claude】受信 → 即200返却 → バックグラウンドでClaude実行
  if (req.method === 'POST' && req.url === '/') {
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

  // 【ステータス確認】後方互換用（WebSocket移行後も残す）
  else if (req.method === 'GET' && req.url === '/status') {
    const status = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : 'idle';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status }));
  }

  // 【ターミナル → Gemini】プッシュ → WebSocketで即配信
  else if (req.method === 'POST' && req.url === '/push') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        fs.writeFileSync(PUSH_FILE, data.text, 'utf8');
        broadcast({ type: 'push', text: data.text });
        log('[Push] Geminiへ送信:\n' + data.text.slice(0, 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch { res.writeHead(400).end(); }
    });
  }

  // 【プッシュ確認】WebSocket未接続時のフォールバック用
  else if (req.method === 'GET' && req.url === '/push-status') {
    if (fs.existsSync(PUSH_FILE)) {
      const text = fs.readFileSync(PUSH_FILE, 'utf8');
      fs.unlinkSync(PUSH_FILE);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: null }));
    }
  }

  // 【スクリプト配信】mtimeをバージョンとして差し込んで返す
  else if (req.method === 'GET' && (req.url === '/tampermonkey_script.js' || req.url === '/tampermonkey_script.user.js')) {
    const scriptPath = join(__dirname, 'tampermonkey_script.js');
    let content = fs.readFileSync(scriptPath, 'utf8');
    const version = Math.floor(fs.statSync(scriptPath).mtimeMs / 1000);
    content = content.replace(/(@version\s+)[\d.]+/, `$1${version}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(content);
  }

  else { res.writeHead(404).end(); }
}

httpServer.listen(PORT, () => {
  log(`Dual-Sync Server running on http://localhost:${PORT} (WebSocket enabled)`);
});
