#!/bin/bash
# 使い方: ./push.sh "Geminiに送りたいテキスト"
TEXT="${1:-}"
if [ -z "$TEXT" ]; then
  echo "使い方: $0 \"送信したいテキスト\""
  exit 1
fi
curl -s -X POST http://localhost:3000/push \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("✅ 送信キューに追加しました" if d.get("status")=="ok" else "❌ 失敗")'
