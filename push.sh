#!/bin/bash
# 使い方:
#   push.sh "質問"              通常送信
#   push.sh -c "質問"           現在のgitリポジトリのコンテキスト（CLAUDE.md）を添付
#   echo "質問" | push.sh       パイプ入力
#   cat file.md | push.sh -c    ファイル内容をコンテキスト付きで送信

USE_CONTEXT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--context) USE_CONTEXT=true; shift ;;
    *) TEXT="$1"; shift ;;
  esac
done

if [ -z "$TEXT" ] && [ ! -t 0 ]; then
  TEXT=$(cat)
fi

if [ -z "$TEXT" ]; then
  echo "使い方: $(basename $0) [-c] \"送信したいテキスト\" または echo \"テキスト\" | $(basename $0) [-c]"
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
    echo "📎 コンテキスト添付: ${PROJECT_NAME}"
  else
    echo "⚠️ gitリポジトリが見つかりません。コンテキストなしで送信します。"
  fi
fi

RESULT=$(curl -s -X POST http://localhost:3000/push \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}")

if echo "$RESULT" | grep -q '"ok"'; then
  echo "✅ 送信キューに追加しました"
else
  echo "❌ 失敗: $RESULT"
  exit 1
fi
