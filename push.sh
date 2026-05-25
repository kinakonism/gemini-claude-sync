#!/bin/bash
# 使い方:
#   push.sh "質問"              fast mode（デフォルト・Geminiの回答を直接ターミナルに表示）
#   push.sh -r "質問"           refine mode（Claudeで精製してGeminiへ戻す、従来動作）
#   push.sh -c "質問"           CLAUDE.md をコンテキストに添付
#   push.sh -n "質問"           ノーウェイト（送信のみで終了、旧挙動）
#   echo "質問" | push.sh       パイプ入力
#   cat file.md | push.sh -c    ファイル内容をコンテキスト付きで送信

USE_CONTEXT=false
MODE="fast"
NO_WAIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--context) USE_CONTEXT=true; shift ;;
    -r|--refine)  MODE="refine"; shift ;;
    -n|--no-wait) NO_WAIT=true; shift ;;
    *) TEXT="$1"; shift ;;
  esac
done

if [ -z "$TEXT" ] && [ ! -t 0 ]; then
  TEXT=$(cat)
fi

if [ -z "$TEXT" ]; then
  echo "使い方: $(basename $0) [-c] [-r] [-n] \"送信したいテキスト\" または echo \"テキスト\" | $(basename $0) [-c] [-r] [-n]"
  exit 1
fi

if [ "$USE_CONTEXT" = true ]; then
  GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$GIT_ROOT" ]; then
    PROJECT_NAME=$(basename "$GIT_ROOT")
    if [ -f "$GIT_ROOT/CLAUDE.md" ]; then
      CONTEXT=$(cat "$GIT_ROOT/CLAUDE.md")
      TEXT="## プロジェクトコンテキスト: ${PROJECT_NAME}

${CONTEXT}

---

${TEXT}"
    else
      TEXT="## プロジェクト: ${PROJECT_NAME}

---

${TEXT}"
    fi
    echo "📎 コンテキスト添付: ${PROJECT_NAME}" >&2
  else
    echo "⚠️ gitリポジトリが見つかりません。コンテキストなしで送信します。" >&2
  fi
fi

if ! curl -sf http://localhost:3000/status > /dev/null 2>&1; then
  echo "❌ サーバーが起動していません。'launchctl load ~/Library/LaunchAgents/com.gemini-claude-sync.plist' を実行してください" >&2
  exit 1
fi

PAYLOAD=$(python3 -c '
import json, sys
data = {"text": sys.stdin.read().strip(), "mode": sys.argv[1]}
print(json.dumps(data))
' "$MODE" <<< "$TEXT")

RESULT=$(curl -s -X POST http://localhost:3000/push \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD")

if ! echo "$RESULT" | grep -q '"ok"'; then
  echo "❌ 送信失敗: $RESULT" >&2
  exit 1
fi

TS=$(echo "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ts",""))')

if [ "$NO_WAIT" = true ]; then
  echo "✅ 送信キューに追加しました（mode=${MODE}, ts=${TS}）" >&2
  exit 0
fi

echo "⏳ Geminiの応答を待機中... (mode=${MODE})" >&2

# ブロッキング待機: max 3分
RESPONSE=$(curl -s --max-time 200 "http://localhost:3000/wait?ts=${TS}")
STATUS=$(echo "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)

if [ "$STATUS" = "ok" ]; then
  echo "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("text",""))'
elif [ "$STATUS" = "timeout" ]; then
  echo "⌛ タイムアウト（応答なし）" >&2
  exit 2
else
  echo "❌ 応答取得失敗: $RESPONSE" >&2
  exit 3
fi
