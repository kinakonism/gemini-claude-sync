// server.js (双方向対応版 + Claude自動実行 + ロングポーリング)
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, execSync } from 'child_process'; // spawn: Claude起動用, execSync: osascript通知用

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
const WAIT_TIMEOUT_MS = 3 * 60 * 1000;   // /wait のタイムアウト
const RESPONSE_BUFFER_TTL_MS = 60 * 1000; // /wait より先に応答が届いた時の保持時間

// ---- フロー状態（push.shの待機 / fast vs refine切替） ----
// activeFlow: 直近のpush.shの状態。POST / 受信時にこれを見てモードを切り替える。
// responseBuffer: /wait より先に応答が届いた場合の取りこぼし防止（ts → {text, expiry}）。
// activeWaiter: /wait の長期コネクションを保持。
let activeFlow = null;
let activeWaiter = null;
const responseBuffer = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ts, v] of responseBuffer) if (v.expiry < now) responseBuffer.delete(ts);
}, 30_000).unref();

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
// Gemini本文を受け取ったら、Claudeに「claude_out.md へ応答本文を書く」よう明示指示する。
// stdoutはあくまでメタログとして扱い、Gemini に返す本文はファイルから読む。
const SYSTEM_INSTRUCTION = [
  '以下はWeb版Geminiから受信したメッセージです。これに対する応答を作成してください。',
  '',
  '【厳守事項】',
  '- 応答の本文（Geminiにそのまま渡される内容）は `claude_out.md` に Write ツールで書き出してください。',
  '- 「応答を書き込みました」のようなメタ要約は不要です。本文だけをファイルに保存してください。',
  '- stdout には簡潔な完了報告（1〜2行）のみ出力してください（本文を二重に出力しないこと）。',
  '- 本文は Markdown 形式。前置きや締めの定型文は省き、実質的な内容のみ。',
  '',
  '---',
  '',
].join('\n');

function buildPrompt(geminiText) {
  return SYSTEM_INSTRUCTION + geminiText;
}

function runClaude(geminiText, onDone) {
  const finish = (text, status) => { if (typeof onDone === 'function') onDone(text || '', status || 'done'); };
  const currentStatus = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : 'idle';
  if (currentStatus === 'running') {
    log('[Claude] 既に実行中のため無視します');
    broadcastEvent({ type: 'claude_done', status: 'busy', text: '' });
    finish('', 'busy');
    return;
  }
  fs.writeFileSync(STATUS_FILE, 'running', 'utf8');
  log('[Claude] 実行開始...');

  // claude_out.md の更新検知用に実行前 mtime を記録
  const beforeMtimeMs = fs.existsSync(CLAUDE_TO_GEMINI_FILE)
    ? fs.statSync(CLAUDE_TO_GEMINI_FILE).mtimeMs
    : 0;

  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const claude = spawn(claudeBin, [
    '-p', buildPrompt(geminiText),
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
    '--dangerously-skip-permissions',
  ], { env: process.env, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });

  const timer = setTimeout(() => {
    claude.kill();
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    log('[Claude] タイムアウト（5分）で強制終了しました');
    notify('Claude Code', 'タイムアウト（5分）で終了しました');
    broadcastEvent({ type: 'claude_done', status: 'timeout', text: '' });
    finish('', 'timeout');
  }, CLAUDE_TIMEOUT_MS);

  let stdoutBuf = '';
  claude.stdout.on('data', (data) => {
    const chunk = data.toString();
    stdoutBuf += chunk;
    process.stdout.write(chunk);
    fs.appendFileSync(LOG_FILE, chunk);
  });
  claude.stderr.on('data', (data) => { const m = data.toString().trim(); if (m) log('[Claude stderr]', m); });
  claude.on('error', (err) => {
    clearTimeout(timer);
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    log('[Claude] 起動失敗:', err.message);
    broadcastEvent({ type: 'claude_done', status: 'error', text: '' });
    finish('', 'error');
  });
  claude.on('close', (code) => {
    clearTimeout(timer);
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    if (code !== 0) {
      log(`[Claude] 終了コード: ${code}`);
      broadcastEvent({ type: 'claude_done', status: 'error', text: '' });
      finish('', 'error');
      return;
    }

    // Claudeが claude_out.md を更新したかチェック
    const afterMtimeMs = fs.existsSync(CLAUDE_TO_GEMINI_FILE)
      ? fs.statSync(CLAUDE_TO_GEMINI_FILE).mtimeMs
      : 0;
    const fileUpdated = afterMtimeMs > beforeMtimeMs;

    let bodyForGemini = '';
    if (fileUpdated) {
      bodyForGemini = fs.readFileSync(CLAUDE_TO_GEMINI_FILE, 'utf8').trim();
      log(`[Claude] claude_out.md 更新を検知 (${bodyForGemini.length} chars)`);
    } else {
      // フォールバック: Claudeがファイル書き込みを怠った場合、stdoutを採用
      bodyForGemini = stdoutBuf.trim();
      if (bodyForGemini) {
        fs.writeFileSync(CLAUDE_TO_GEMINI_FILE, bodyForGemini, 'utf8');
        log(`[Claude] claude_out.md 未更新 → stdout(${bodyForGemini.length} chars)をフォールバック採用`);
      }
    }

    log('\n' + '─'.repeat(40));
    if (bodyForGemini) {
      notify('Claude Code', '完了しました');
      broadcastEvent({ type: 'claude_done', status: 'done', text: bodyForGemini });
      finish(bodyForGemini, 'done');
    } else {
      log('[Claude] 本文が空のため Gemini への配信をスキップ');
      broadcastEvent({ type: 'claude_done', status: 'error', text: '' });
      finish('', 'error');
    }
  });
}

// ---- 応答の解決（fast/refineどちらでもここを通す） ----
function deliverResponse(text) {
  const ts = activeFlow ? activeFlow.ts : null;
  if (activeWaiter && (!ts || activeWaiter.ts === ts) && !activeWaiter.sent) {
    activeWaiter.sent = true;
    clearTimeout(activeWaiter.timer);
    activeWaiter.res.writeHead(200, { 'Content-Type': 'application/json' });
    activeWaiter.res.end(JSON.stringify({ status: 'ok', text }));
    activeWaiter = null;
    log(`[Wait] push.sh へ応答配信 (${text.length} chars)`);
  } else if (ts) {
    // /wait より先に到着 → バッファに保持
    responseBuffer.set(ts, { text, expiry: Date.now() + RESPONSE_BUFFER_TTL_MS });
    log(`[Wait] バッファに保持 ts=${ts} (${text.length} chars)`);
  }
  activeFlow = null;
}

// ---- スクリプト変更の監視（ローダー本体 / runtime両方） ----
const scriptPath = join(__dirname, 'tampermonkey_script.js');
const runtimePath = join(__dirname, 'runtime.js');
let reloadTimer = null;
function scheduleReload(label) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    log(`[Watch] ${label} が更新されました。クライアントに通知します。`);
    broadcastEvent({ type: 'script_updated' });
  }, 300);
}
fs.watch(scriptPath, () => scheduleReload('tampermonkey_script.js'));
if (fs.existsSync(runtimePath)) fs.watch(runtimePath, () => scheduleReload('runtime.js'));

// ---- HTTPサーバー ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://gemini.google.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 【イベントストリーム】Tampermonkeyがロングポーリングで受信
  if (req.method === 'GET' && req.url === '/events') {
    // 新規接続時に pending push があれば即座に返す
    // （バックグラウンドタブでも XHR の onload は発火するため、
    //   25秒ごとの heartbeat 再接続のたびに確実に配信される）
    if (fs.existsSync(PUSH_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
        // 配信と同時にファイル削除（Tampermonkey の ACK 待ちでループしない）
        fs.unlinkSync(PUSH_FILE);
        log('[Events] 新規接続 → pending push を即配信（自動ACK）');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'push', text: raw.text, ts: raw.ts }));
        return;
      } catch {}
    }

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

  // 【Gemini ➔ サーバー】受信 → 即200返却 → モードに応じて処理
  //   fast   : Geminiの本文をそのまま push.sh へ返す（Claudeを呼ばない・最速）
  //   refine : Claudeで精製してGeminiへ戻す（従来動作）
  else if (req.method === 'POST' && req.url === '/') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Tampermonkeyが付けるプレフィクス & Gemini UI由来のラベルを剥がす
        const geminiText = (data.text || '')
          .replace(/^## Geminiの回答:\s*/i, '')
          .replace(/^Gemini\s*の?回答\s*\n+/i, '')
          .replace(/^Gemini'?s?\s*answer\s*\n+/i, '')
          .trim();
        const content = `### Gemini Context (${new Date().toLocaleString()})\n\n${geminiText}\n`;
        fs.writeFileSync(GEMINI_TO_CLAUDE_FILE, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));

        const mode = (activeFlow && activeFlow.mode) || 'refine'; // 手動ボタン経由はrefine
        if (mode === 'fast') {
          // Geminiの本文を直接 claude_out.md にも保存（手動「📥」ボタンとの整合）
          fs.writeFileSync(CLAUDE_TO_GEMINI_FILE, geminiText, 'utf8');
          log(`[Fast] Geminiの回答を直接配信 (${geminiText.length} chars)`);
          // fast mode では Tampermonkey に "claude_done" を送らない（自動入力ループを避ける）
          deliverResponse(geminiText);
        } else {
          log('[Refine] Geminiの指示を受信。Claudeを起動します。');
          runClaude(geminiText, (text) => deliverResponse(text));
        }
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
  // body.mode = 'fast' (デフォルト、Claudeスキップ) | 'refine' (Claude精製)
  else if (req.method === 'POST' && req.url === '/push') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const ts = Date.now();
        const mode = data.mode === 'refine' ? 'refine' : 'fast';
        activeFlow = { mode, ts };
        fs.writeFileSync(PUSH_FILE, JSON.stringify({ text: data.text, ts }), 'utf8');
        broadcastEvent({ type: 'push', text: data.text, ts });
        log(`[Push] mode=${mode} Geminiへ送信:\n` + data.text.slice(0, 100));
        // Chrome をフォアグラウンドに → バックグラウンドタブのJS throttling を解除
        const ac = spawn('osascript', ['-e', 'tell application "Google Chrome" to activate'], { detached: true, stdio: 'ignore' });
        ac.unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ts, mode }));
      } catch { res.writeHead(400).end(); }
    });
  }

  // 【push.sh のブロッキング待機】GET /wait?ts=<ts> → 応答が出るまで保留
  else if (req.method === 'GET' && req.url.startsWith('/wait')) {
    const m = req.url.match(/[?&]ts=(\d+)/);
    const ts = m ? parseInt(m[1], 10) : 0;
    // バッファに既に応答があれば即返却
    const buffered = responseBuffer.get(ts);
    if (buffered) {
      responseBuffer.delete(ts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', text: buffered.text }));
      return;
    }
    // 既存のwaiterは破棄（最新のpush.shだけが待つ）
    if (activeWaiter && !activeWaiter.sent) {
      activeWaiter.sent = true;
      clearTimeout(activeWaiter.timer);
      try { activeWaiter.res.writeHead(200).end(JSON.stringify({ status: 'superseded', text: '' })); } catch {}
    }
    const waiter = { res, ts, sent: false };
    waiter.timer = setTimeout(() => {
      if (!waiter.sent) {
        waiter.sent = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'timeout', text: '' }));
        if (activeWaiter === waiter) activeWaiter = null;
      }
    }, WAIT_TIMEOUT_MS);
    req.on('close', () => {
      if (!waiter.sent) {
        waiter.sent = true;
        clearTimeout(waiter.timer);
        if (activeWaiter === waiter) activeWaiter = null;
      }
    });
    activeWaiter = waiter;
  }

  // 【ページロード時確認】未処理の pending push を返す
  else if (req.method === 'GET' && req.url === '/pending') {
    try {
      if (fs.existsSync(PUSH_FILE)) {
        const raw = fs.readFileSync(PUSH_FILE, 'utf8');
        const data = JSON.parse(raw);
        log('[Pending] Tampermonkey が /pending にアクセス → pending あり');
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
      log('[ACK] Tampermonkey が /ack → pending 削除完了');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch { res.writeHead(500).end(); }
  }

  // 【スクリプト配信】mtimeをバージョンとして差し込んで返す
  // 【タブ閉じ】接続中の全Tampermonkeyタブに close_tab イベントを送信
  else if (req.method === 'POST' && req.url === '/close-tabs') {
    broadcastEvent({ type: 'close_tab' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: longPollClients.length }));
  }

  else if (req.method === 'GET' && (req.url === '/tampermonkey_script.js' || req.url === '/tampermonkey_script.user.js')) {
    let content = fs.readFileSync(scriptPath, 'utf8');
    const version = Math.floor(fs.statSync(scriptPath).mtimeMs / 1000);
    content = content.replace(/(@version\s+)[\d.]+/, `$1${version}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(content);
  }

  // 【診断】runtime.jsが起動したことを報告
  else if (req.method === 'POST' && req.url === '/hello') {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        log(`[Hello] runtime online: version=${d.version || '?'} url=${d.url || '?'}`);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  }

  // 【runtime配信】Tampermonkeyローダーが動的取得する。no-cacheで毎回最新を返す。
  else if (req.method === 'GET' && req.url.startsWith('/runtime.js')) {
    try {
      const content = fs.readFileSync(runtimePath, 'utf8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(content);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  }

  else { res.writeHead(404).end(); }
});

server.listen(PORT, () => {
  log(`Dual-Sync Server running on http://localhost:${PORT} (long polling enabled)`);
});
