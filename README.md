# Gemini ↔ Claude Code Bi-directional Sync

Web版Gemini（gemini.google.com）とClaude Code（ターミナル）の間でコンテキストを双方向にシームレス共有するツールです。

## 仕組み

```
[Web版Gemini] --POST--> [localhost:3000] --> gemini_ctx.md --> [Claude Code]
[Claude Code] --> claude_out.md --> [localhost:3000] --GET--> [Web版Gemini]
```

Tampermonkeyスクリプトがブラウザ上にボタンを表示し、ワンクリックで同期できます。

## セットアップ

### 1. サーバーの起動

```bash
git clone https://github.com/YOUR_USERNAME/gemini-claude-sync.git ~/developer/gemini-claude-sync
cd ~/developer/gemini-claude-sync
node server.js
```

### 2. Tampermonkeyスクリプトの登録

1. ブラウザに [Tampermonkey](https://www.tampermonkey.net/) をインストール
2. 「新しいスクリプトを追加」を選択
3. `tampermonkey_script.js` の内容を貼り付けて保存

### 3. Claude Code への設定

`~/.claude/CLAUDE.md` に以下を追記します（パスは実際の場所に合わせてください）：

```markdown
## Gemini同期ファイル
- `~/developer/gemini-claude-sync/gemini_ctx.md` — Geminiからの入力（読み込み専用）
- `~/developer/gemini-claude-sync/claude_out.md` — Claudeからの出力（書き込み専用）
```

## 使い方

| 操作 | 方法 |
|---|---|
| Gemini → Claude | Gemini画面右下の **📚 Send ALL History** を押す |
| Claude → Gemini | Claudeに「Gemini用に書き出して」と指示後、**📥 Receive from Claude** を押す |

## ファイル構成

| ファイル | 説明 |
|---|---|
| `server.js` | 双方向同期用ローカルサーバー（port 3000） |
| `tampermonkey_script.js` | Gemini画面にボタンを追加するブラウザスクリプト |
| `package.json` | ESモジュール設定 |
| `gemini_ctx.md` | 同期ファイル（自動生成・gitignore済み） |
| `claude_out.md` | 同期ファイル（自動生成・gitignore済み） |
