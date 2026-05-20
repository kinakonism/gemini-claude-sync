# Gemini ↔ Claude Code Bi-directional Sync

Web版Gemini（gemini.google.com）とClaude Code（ターミナル）の間でコンテキストを双方向・自動でやり取りするローカル連携システムです。

## 全体像

```
ターミナル
  └─ push.sh "質問"
        ↓ POST /push
  [localhost:3000]
        ↓ ロングポーリング（GM_xmlhttpRequest）
  [Web版Gemini] ← 自動入力・自動送信
        ↓ Geminiが回答
  MutationObserverが回答を検知
        ↓ POST /
  [localhost:3000]
        ↓ claude -p を自動実行
  ターミナルに結果表示 + claude_out.md に保存
        ↓ ロングポーリングで通知
  [Web版Gemini] ← Claudeの回答を自動入力
```

> **なぜロングポーリングか**  
> Geminiの Content Security Policy が `ws://localhost` WebSocket接続をブロックします。  
> TampermonkeyのGM_xmlhttpRequestはCSPをバイパスできるため、これを使ったロングポーリングで代替しています。

## セットアップ

### 1. リポジトリのクローン

```bash
git clone https://github.com/kinakonism/gemini-claude-sync.git ~/developer/gemini-claude-sync
cd ~/developer/gemini-claude-sync
```

### 2. サーバーの起動（手動）

```bash
node server.js
```

### 2'. サーバーの自動起動（Mac推奨）

ログイン時に自動起動・クラッシュ時に自動再起動させる場合は launchd に登録します。

```bash
# plist を LaunchAgents にコピー（パスを自分の環境に合わせて編集してから実行）
cp com.gemini-claude-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.gemini-claude-sync.plist
```

`com.gemini-claude-sync.plist` 内の以下2箇所を自分の環境に合わせて書き換えてください：

```xml
<!-- node のパス（which node で確認） -->
<string>/Users/YOUR_NAME/.nvm/versions/node/vX.X.X/bin/node</string>

<!-- server.js のパス -->
<string>/Users/YOUR_NAME/developer/gemini-claude-sync/server.js</string>
```

### 3. Tampermonkeyスクリプトの登録

1. ブラウザに [Tampermonkey](https://www.tampermonkey.net/) をインストール
2. Tampermonkeyダッシュボード → ユーティリティ → 「URLからインストール」に以下を入力：
   ```
   http://localhost:3000/tampermonkey_script.user.js
   ```
3. インストール後、gemini.google.com を開くと右下にボタンが表示される

> **自動更新について**  
> スクリプトはサーバーから配信されます。ローカルの `tampermonkey_script.js` を編集・保存すると、Geminiを開いているブラウザが自動的にリロードされ即時反映されます。

### 4. Claude Code への設定

`~/.claude/CLAUDE.md` に以下を追記します（パスは実際の場所に合わせてください）：

```markdown
## Gemini同期ファイル
- `/Users/YOUR_NAME/developer/gemini-claude-sync/gemini_ctx.md` — Geminiからの入力（読み込み専用）
- `/Users/YOUR_NAME/developer/gemini-claude-sync/claude_out.md` — Claudeからの出力（書き込み専用）
```

### 5. push.sh に実行権限を付与

```bash
chmod +x ~/developer/gemini-claude-sync/push.sh
```

### 6. （任意）~/.zshrc にエイリアス登録

```bash
echo 'alias g2c="~/developer/gemini-claude-sync/push.sh"' >> ~/.zshrc
source ~/.zshrc
```

登録後は `g2c "質問"` や `cat file.md | g2c` で使えます。  
（`gemini` コマンドは Gemini CLI と名前が衝突するため `g2c` を推奨）

---

## 使い方

### ターミナル → Gemini → Claude（完全自動ラウンドトリップ）

```bash
# 文字列で直接指定
~/developer/gemini-claude-sync/push.sh "日本の首都はどこですか？"

# パイプで渡す
echo "質問内容" | ~/developer/gemini-claude-sync/push.sh

# ファイルの内容を渡す
cat memo.md | ~/developer/gemini-claude-sync/push.sh

# 現在のgitリポジトリのCLAUDE.mdをコンテキストとして添付
~/developer/gemini-claude-sync/push.sh -c "このコードをレビューして"
cat src/main.py | ~/developer/gemini-claude-sync/push.sh -c
```

1. Gemini画面に自動入力・自動送信
2. Geminiの回答を検知してClaudeに自動送信
3. ターミナルにClaudeの回答が表示される
4. Claudeの回答がGeminiの入力欄に自動セット（さらに続けることも可能）

### ブラウザのボタン操作

| ボタン | 動作 |
|---|---|
| **📤 Gemini → Claude** | Geminiの会話（前回送信以降の差分）をClaudeに送信・自動実行 |
| **📥 Claude → Gemini** | `claude_out.md` の内容をGeminiの入力欄にセット |

> **差分送信について**  
> 📤ボタンは2回目以降、前回送った位置から新しいメッセージのみを送信します。会話URLが変わると自動リセットされます。

---

## ファイル構成

| ファイル | 説明 |
|---|---|
| `server.js` | 双方向同期ローカルサーバー（port 3000） |
| `tampermonkey_script.js` | Gemini画面にボタンを追加するブラウザスクリプト |
| `push.sh` | ターミナルからGeminiにテキストを送るCLIスクリプト |
| `package.json` | ESモジュール設定 |
| `com.gemini-claude-sync.plist` | macOS launchd 自動起動設定（要パス書き換え） |
| `server.log` | サーバーログ（1MB超でserver.log.oldにローテーション、gitignore済み） |
| `gemini_ctx.md` | 同期ファイル・自動生成（gitignore済み） |
| `claude_out.md` | 同期ファイル・自動生成（gitignore済み） |

## APIエンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/` | Gemini会話を受信してclaudeを自動実行 |
| GET | `/` | `claude_out.md` の内容を返す |
| GET | `/status` | Claude実行状態（idle / running / done）を返す |
| POST | `/push` | ターミナルからGeminiへ送信（ロングポーリングで即配信） |
| GET | `/events` | ロングポーリングエンドポイント（25秒タイムアウト、heartbeat返却） |
| GET | `/tampermonkey_script.user.js` | スクリプトをmtimeベースのバージョンで配信 |

## トラブルシューティング

**スクリプトが自動リロードされない**  
→ Tampermonkeyダッシュボードでスクリプトが有効になっているか確認。Geminiのタブをリロードして再初期化する。

**入力欄にテキストが入らない**  
→ Geminiのタブをアクティブな状態（フォアグラウンド）にしてから再送信。Geminiの UI 構造が変わった場合はIssueを立ててください。

**`spawn claude ENOENT` エラー（launchd経由）**  
→ launchdはnvmのPATHを引き継がないため、`server.js`の`CLAUDE_BIN`定数にclaudeの絶対パス（`which claude`で確認）を設定してください。または環境変数`CLAUDE_BIN`で上書きできます。

**Claudeが二重起動する**  
→ 前の実行が完了する前にもう一度送信すると「既に実行中」として無視されます（正常動作）。

## 注意事項

- `--dangerously-skip-permissions` を使用しているため、Geminiからの指示が確認なしで実行されます。**信頼できる自分の会話のみ**で使用してください。
- `server.log` に会話内容が記録されます。機密情報の取り扱いに注意してください。
