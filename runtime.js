// === Gemini ↔ Claude Code Sync — Runtime ===
//
// このファイルはTampermonkeyローダーから eval される。
// ローダーのクロージャ経由でGM_xmlhttpRequestを参照する。
//
// 編集後はGemini画面の自動リロードで即時反映される（Tampermonkey手動更新不要）。
//
// 開発上の注意:
//   - return文はトップレベルでは使えない。早期離脱が必要な箇所はIIFEで囲む。

(function () {
  'use strict';

  if (window.__geminiSyncInit) {
    console.log('[Gemini Sync] runtime already initialized, skipping');
    return;
  }
  // iframe (bscframe等) では二重起動になるので除外
  if (window.top !== window) {
    console.log('[Gemini Sync] running in iframe, skipping');
    return;
  }
  window.__geminiSyncInit = true;

  const SERVER_URL = 'http://localhost:3000';
  let lastSentCount = 0;
  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; lastSentCount = 0; } }, 1000);

  // ---- UI パネル ----
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;font-family:sans-serif;';
  const btnStyle = 'padding:10px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.25);';

  const sendBtn = document.createElement('button');
  sendBtn.textContent = '📤 Gemini → Claude';
  sendBtn.style.cssText = btnStyle + 'background:#4285F4;color:white;';
  sendBtn.addEventListener('click', () => {
    const text = extractGeminiConversation();
    if (!text) { showToast('⚠️ 会話テキストが見つかりませんでした', 'warning'); return; }
    GM_xmlhttpRequest({
      method: 'POST', url: SERVER_URL + '/',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ text }),
      onload: (res) => {
        if (res.status === 200) { showToast('⚡ Claude Code 実行中...', 'warning'); sendBtn.textContent = '⏳ 処理中...'; sendBtn.disabled = true; }
        else showToast('❌ 送信失敗: ' + res.status, 'error');
      },
      onerror: () => showToast('❌ サーバーに接続できません', 'error'),
    });
  });

  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = '📥 Claude → Gemini';
  fetchBtn.style.cssText = btnStyle + 'background:#34A853;color:white;';
  fetchBtn.addEventListener('click', () => {
    GM_xmlhttpRequest({
      method: 'GET', url: SERVER_URL + '/',
      onload: (res) => {
        if (res.status === 200) {
          const data = JSON.parse(res.responseText);
          setGeminiInput(data.text);
        }
      },
      onerror: () => showToast('❌ サーバーに接続できません', 'error'),
    });
  });

  panel.appendChild(sendBtn);
  panel.appendChild(fetchBtn);
  document.body.appendChild(panel);

  // ---- ロングポーリング ----
  function startLongPoll() {
    GM_xmlhttpRequest({
      method: 'GET', url: SERVER_URL + '/events', timeout: 30000,
      onload: (res) => {
        try {
          const d = JSON.parse(res.responseText);
          if (d.type !== 'heartbeat') handleServerEvent(d);
        } catch {}
        startLongPoll();
      },
      onerror: () => setTimeout(startLongPoll, 3000),
      ontimeout: () => startLongPoll(),
    });
  }

  // ---- ACK（pending削除）----
  function sendAck() {
    GM_xmlhttpRequest({
      method: 'POST', url: SERVER_URL + '/ack',
      headers: { 'Content-Type': 'application/json' },
      data: '{}', onload: () => {}, onerror: () => {},
    });
  }

  // ---- サーバーイベント処理 ----
  function handleServerEvent(data) {
    if (data.type === 'push') {
      sendAck();
      showToast('📨 受信 → Gemini送信中...', 'warning');
      const ok = setGeminiInput(data.text);
      if (ok) {
        waitForSendButton(2000).then(btn => {
          if (btn) {
            btn.click();
            showToast('🚀 Gemini送信完了、回答待ち...', 'success');
            watchForGeminiResponse();
          } else {
            const input = deepQuery('.ql-editor') || deepQuery('[contenteditable="true"]');
            if (input) {
              input.focus();
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
              showToast('🚀 Enter送信', 'success');
              watchForGeminiResponse();
            } else {
              showToast('⚠️ 送信ボタンも入力欄も見つかりません', 'error');
            }
          }
        });
      }
    }
    if (data.type === 'claude_done' && data.status === 'done') {
      sendBtn.textContent = '📤 Gemini → Claude';
      sendBtn.disabled = false;
      if (data.text) setGeminiInput(data.text);
    }
    if (data.type === 'script_updated') {
      showToast('🔄 runtime更新 → リロード', 'warning');
      setTimeout(() => location.reload(), 800);
    }
    if (data.type === 'close_tab') {
      showToast('🗑️ 重複タブを閉じます', 'warning');
      setTimeout(() => { window.open('', '_self'); window.close(); }, 500);
    }
  }

  // ---- 送信ボタンが有効になるまで待つ ----
  function waitForSendButton(timeoutMs) {
    return new Promise(resolve => {
      const selectors = [
        'button[aria-label="送信"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
        'button[data-mat-icon-name="send"]',
        'button[jsname="Qx7uuf"]',
        '.send-button',
        '[data-testid="send-button"]',
      ];
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const btn = selectors.map(s => deepQuery(s)).find(el => el && !el.disabled);
        if (btn) { resolve(btn); return; }
        if (Date.now() > deadline) {
          const anyBtn = selectors.map(s => deepQuery(s)).find(el => el);
          resolve(anyBtn || null);
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  startLongPoll();
  checkPendingOnLoad();
  setInterval(checkPendingOnLoad, 60000);

  // ---- ページロード時に未処理 pending を自動送信 ----
  function checkPendingOnLoad() {
    setTimeout(() => {
      GM_xmlhttpRequest({
        method: 'GET', url: SERVER_URL + '/pending',
        onload: (res) => {
          try {
            const d = JSON.parse(res.responseText);
            if (!d.pending) return;
            const lastTs = parseInt(sessionStorage.getItem('lastPushTs') || '0', 10);
            if (d.ts <= lastTs) return;
            sessionStorage.setItem('lastPushTs', String(d.ts));
            showToast('📨 pending メッセージ → 送信中...', 'warning');
            sendAck();
            const ok = setGeminiInput(d.text);
            if (ok) {
              waitForSendButton(3000).then(btn => {
                if (btn) {
                  btn.click();
                  showToast('🚀 Gemini送信完了', 'success');
                  watchForGeminiResponse();
                }
              });
            }
          } catch {}
        },
        onerror: () => {},
      });
    }, 2500);
  }

  // ---- Geminiの回答を監視してサーバーに送信 ----
  // テキスト変化ベースのdebounce: 関連検索・ソースUI等の後付けDOM変化は
  //   テキストが変わらないので debounce 時計を伸ばさない。
  // STABILITY_MS = 700ms: テキストが0.7秒変わらなければ完了とみなす。
  function watchForGeminiResponse() {
    const container = deepQuery('chat-history') ||
                      document.querySelector('main') ||
                      document.body;

    const getResponseCount = () =>
      container.querySelectorAll('model-response, message-content, [data-message-role="model"]').length;

    const getText = () => {
      const selectors = [
        'model-response .markdown',
        'model-response',
        'message-content',
        '[data-message-role="model"]',
      ];
      for (const sel of selectors) {
        const nodes = container.querySelectorAll(sel);
        if (!nodes.length) continue;
        const last = nodes[nodes.length - 1];
        const t = last && last.innerText && last.innerText.trim();
        if (t && t.length > 0) return t;
      }
      return '';
    };

    const STABILITY_MS = 700;
    const MAX_WAIT_MS = 180_000;
    const initialCount = getResponseCount();
    const startedAt = Date.now();
    let lastText = '';
    let debounceTimer = null;
    let triggered = false;
    let observer = null;

    const fire = () => {
      if (triggered) return;
      // 生成中の場合は追加待機（aria-busyが残っていれば再延長）
      if (deepQuery('[aria-busy="true"]')) {
        debounceTimer = setTimeout(fire, 300);
        return;
      }
      const text = getText();
      if (!text) {
        debounceTimer = setTimeout(fire, 300);
        return;
      }
      // 直前のテキスト読み取りから状態が変わっていれば再延長
      if (text !== lastText) {
        lastText = text;
        debounceTimer = setTimeout(fire, STABILITY_MS);
        return;
      }
      triggered = true;
      if (observer) observer.disconnect();
      clearTimeout(debounceTimer);
      console.log('[Gemini Sync] response stable:', text.slice(0, 100));
      sendGeminiAnswer(text);
    };

    observer = new MutationObserver(() => {
      if (triggered) return;
      if (getResponseCount() <= initialCount) return;
      const text = getText();
      if (!text || text === lastText) return; // テキスト不変 → timerリセットしない
      lastText = text;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fire, STABILITY_MS);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    setTimeout(() => {
      if (triggered) return;
      if (observer) observer.disconnect();
      console.warn('[Gemini Sync] watch timeout');
    }, MAX_WAIT_MS);
  }

  function sendGeminiAnswer(text) {
    GM_xmlhttpRequest({
      method: 'POST', url: SERVER_URL + '/',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ text }),
      onload: (res) => {
        if (res.status === 200) showToast('✅ サーバーへ送信完了', 'success');
        else showToast('❌ 送信失敗: ' + res.status, 'error');
      },
      onerror: () => showToast('❌ サーバーエラー', 'error'),
    });
  }

  // ---- Geminiの会話を抽出 ----
  function extractGeminiConversation() {
    const selectors = ['model-response .markdown', '.response-content', 'message-content', '[data-message-role]'];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (!nodes.length) continue;
      const newNodes = Array.from(nodes).slice(lastSentCount);
      if (!newNodes.length) { showToast('⚠️ 新しいメッセージなし', 'warning'); return null; }
      const text = newNodes.map(n => n.innerText.trim()).filter(t => t).join('\n\n---\n\n');
      lastSentCount = nodes.length;
      return text;
    }
    const body = document.body.innerText;
    return body.length > 100 ? body.slice(0, 8000) : null;
  }

  // ---- shadow DOM 再帰検索 ----
  function deepQuery(sel, root = document) {
    const el = root.querySelector(sel);
    if (el) return el;
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) {
        const found = deepQuery(sel, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  // ---- テキスト挿入（execCommand優先、TrustedTypes対応）----
  function setGeminiInput(text) {
    const editor = deepQuery('.ql-editor[contenteditable="true"]') ||
                   deepQuery('rich-textarea [contenteditable="true"]') ||
                   deepQuery('[contenteditable="true"]');

    if (editor) {
      editor.focus();
      try {
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, text);
        if (ok) { showToast('✅ 入力セット(execCommand)', 'success'); return true; }
      } catch (e) { console.warn('[Gemini Sync] execCommand failed:', e); }

      try {
        editor.focus();
        document.execCommand('selectAll', false, null);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        showToast('✅ 入力セット(paste)', 'success');
        return true;
      } catch (e) { console.warn('[Gemini Sync] paste failed:', e); }

      const p = editor.querySelector('p') || editor;
      p.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      showToast('✅ 入力セット(textContent)', 'success');
      return true;
    }

    const ta = deepQuery('textarea');
    if (ta) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
      ta.dispatchEvent(new Event('input',  { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      showToast('✅ 入力セット(textarea)', 'success');
      return true;
    }

    showToast('⚠️ 入力欄が見つかりません', 'error');
    return false;
  }

  // ---- トースト通知 ----
  function showToast(message, type = 'success') {
    const colors = { success: '#34A853', error: '#EA4335', warning: '#FBBC04' };
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `position:fixed;bottom:130px;right:20px;z-index:100000;background:${colors[type]||colors.success};color:white;padding:10px 16px;border-radius:8px;font-size:13px;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ---- 起動報告（サーバログで可視化）----
  GM_xmlhttpRequest({
    method: 'POST', url: SERVER_URL + '/hello',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ version: 'runtime-' + Date.now(), url: location.href }),
    onload: () => {}, onerror: () => {},
  });
  console.log('[Gemini Sync] runtime initialized at', new Date().toISOString());
})();
