// server.js (双方向対応版 + Claude自動実行)
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const GEMINI_TO_CLAUDE_FILE = join(__dirname, 'gemini_ctx.md');
const CLAUDE_TO_GEMINI_FILE = join(__dirname, 'claude_out.md');
const STATUS_FILE = join(__dirname, '.claude_status');
const PUSH_FILE = join(__dirname, '.claude_push');

function runClaude(prompt) {
  fs.writeFileSync(STATUS_FILE, 'running', 'utf8');
  console.log('[Claude] 実行開始...');

  const claude = spawn('claude', [
    '-p', prompt,
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
    '--dangerously-skip-permissions',
  ], {
    env: process.env,
    cwd: __dirname,
  });

  let output = '';
  claude.stdout.on('data', (data) => { output += data.toString(); });
  claude.stderr.on('data', (data) => { console.error('[Claude stderr]', data.toString()); });

  claude.on('close', (code) => {
    fs.writeFileSync(STATUS_FILE, 'done', 'utf8');
    if (code === 0 && output.trim()) {
      fs.writeFileSync(CLAUDE_TO_GEMINI_FILE, output, 'utf8');
      console.log('[Claude] 完了:\n' + '─'.repeat(40) + '\n' + output.trim() + '\n' + '─'.repeat(40));
    } else {
      console.error(`[Claude] 終了コード: ${code}`);
    }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://gemini.google.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 【Gemini ➔ Claude】受信 → 即200返却 → バックグラウンドでClaude実行
  if (req.method === 'POST') {
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
        console.log('[Success] Geminiの指示を受信。Claudeを起動しました。');
      } catch (err) {
        res.writeHead(400).end();
      }
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
    } catch {
      res.writeHead(500).end();
    }
  }

  // 【ステータス確認】Claudeが実行中かどうか
  else if (req.method === 'GET' && req.url === '/status') {
    const status = fs.existsSync(STATUS_FILE)
      ? fs.readFileSync(STATUS_FILE, 'utf8')
      : 'idle';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status }));
  }

  // 【ターミナル → Gemini】テキストをプッシュしてTampermonkeyに拾わせる
  else if (req.method === 'POST' && req.url === '/push') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        fs.writeFileSync(PUSH_FILE, data.text, 'utf8');
        console.log('[Push] Geminiへの送信キューに追加:\n' + data.text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch {
        res.writeHead(400).end();
      }
    });
  }

  // 【プッシュ確認】Tampermonkeyがポーリングして未送信テキストを取得
  else if (req.method === 'GET' && req.url === '/push-status') {
    res.setHeader('Access-Control-Allow-Origin', 'https://gemini.google.com');
    if (fs.existsSync(PUSH_FILE)) {
      const text = fs.readFileSync(PUSH_FILE, 'utf8');
      fs.unlinkSync(PUSH_FILE); // 読んだら削除（1回限り）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: null }));
    }
  }

  // 【スクリプト配信】ファイルのmtimeをバージョンとして差し込んで返す
  else if (req.method === 'GET' && (req.url === '/tampermonkey_script.js' || req.url === '/tampermonkey_script.user.js')) {
    const scriptPath = join(__dirname, 'tampermonkey_script.js');
    let content = fs.readFileSync(scriptPath, 'utf8');
    const version = Math.floor(fs.statSync(scriptPath).mtimeMs / 1000);
    content = content.replace(/(@version\s+)[\d.]+/, `$1${version}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(content);
  }

  else {
    res.writeHead(404).end();
  }
});

server.listen(PORT, () => {
  console.log(`Dual-Sync Server running on http://localhost:${PORT}`);
});
