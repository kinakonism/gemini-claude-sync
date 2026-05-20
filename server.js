// server.js (双方向対応版)
import http from 'http';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const GEMINI_TO_CLAUDE_FILE = join(__dirname, 'gemini_ctx.md');
const CLAUDE_TO_GEMINI_FILE = join(__dirname, 'claude_out.md');

const server = http.createServer((req, res) => {
  // CORSの設定（Web版Geminiからのリクエストを許可）
  res.setHeader('Access-Control-Allow-Origin', 'https://gemini.google.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 【Gemini ➔ Claude】ブラウザのボタンを押して、会話をローカルに保存
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const content = `### Gemini Context (${new Date().toLocaleString()})\n\n${data.text}\n`;
        fs.writeFileSync(GEMINI_TO_CLAUDE_FILE, content, 'utf8');
        
        console.log(`[Success] Geminiの文脈を ${GEMINI_TO_CLAUDE_FILE} に同期しました。`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        res.writeHead(400).end();
      }
    });
  } 
  
  // 【Claude ➔ Gemini】ブラウザのボタンを押して、Claudeの成果を入力欄に吸い上げる
  else if (req.method === 'GET') {
    try {
      if (fs.existsSync(CLAUDE_TO_GEMINI_FILE)) {
        const content = fs.readFileSync(CLAUDE_TO_GEMINI_FILE, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: content }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: "Claudeからの新しいデータはありません。" }));
      }
    } catch (err) {
      res.writeHead(500).end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Dual-Sync Server running on http://localhost:${PORT}`);
});