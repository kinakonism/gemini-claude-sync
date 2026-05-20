// ==UserScript==
// @name         Gemini <-> Claude Code Bi-directional Sync v5.0
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Web版GeminiとClaude Codeの双方向コンテキスト同期（完全自動ラウンドトリップ対応）
// @author       User
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    http://localhost:3000/tampermonkey_script.user.js
// @downloadURL  http://localhost:3000/tampermonkey_script.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__geminiSyncInit) return;
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
        try { const d = JSON.parse(res.responseText); if (d.type !== 'heartbeat') handleServerEvent(d); } catch {}
        startLongPoll();
      },
      onerror: () => setTimeout(startLongPoll, 3000),
      ontimeout: () => startLongPoll(),
    });
  }

  // ---- サーバーイベント処理 ----
  function handleServerEvent(data) {
    if (data.type === 'push') {
      showToast('📨 受信 → Gemini送信中...', 'warning');
      const ok = setGeminiInput(data.text);
      if (ok) {
        // ボタンが有効になるまで最大2秒リトライしてから送信
        waitForSendButton(2000).then(btn => {
          if (btn) {
            btn.click();
            showToast('🚀 Gemini送信完了、回答待ち...', 'success');
            watchForGeminiResponse();
          } else {
            // Enterキーフォールバック
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
      showToast('🔄 スクリプト更新 → リロード', 'warning');
      setTimeout(() => location.reload(), 1000);
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
          // タイムアウト: disabled でも一応返す
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

  // ---- ページロード時に未処理 pending を自動送信 ----
  function checkPendingOnLoad() {
    // ページが完全に読み込まれるまで少し待つ
    setTimeout(() => {
      GM_xmlhttpRequest({
        method: 'GET', url: SERVER_URL + '/pending',
        onload: (res) => {
          try {
            const d = JSON.parse(res.responseText);
            if (!d.pending) return;
            // 既にこのセッションで処理済みなら skip
            const lastTs = parseInt(sessionStorage.getItem('lastPushTs') || '0', 10);
            if (d.ts <= lastTs) return;
            sessionStorage.setItem('lastPushTs', String(d.ts));
            showToast('📨 pending メッセージ → 送信中...', 'warning');
            const ok = setGeminiInput(d.text);
            if (ok) {
              waitForSendButton(3000).then(btn => {
                if (btn) {
                  btn.click();
                  showToast('🚀 Gemini送信完了', 'success');
                  watchForGeminiResponse();
                }
                // ack でサーバーの pending を削除
                GM_xmlhttpRequest({ method: 'POST', url: SERVER_URL + '/ack',
                  headers: { 'Content-Type': 'application/json' },
                  data: '{}', onload: () => {} });
              });
            }
          } catch {}
        },
        onerror: () => {},
      });
    }, 2500);
  }

  // ---- Geminiの回答を監視してサーバーに送信 ----
  function watchForGeminiResponse() {
    const container = deepQuery('chat-history') ||
                      document.querySelector('main') ||
                      document.body;

    const getResponseCount = () =>
      container.querySelectorAll('model-response, message-content, [data-message-role="model"]').length;

    const initialCount = getResponseCount();
    let debounceTimer = null;
    let triggered = false;

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
        const t = nodes[nodes.length - 1]?.innerText?.trim();
        if (t && t.length > 20) return t;
      }
      return '';
    };

    const observer = new MutationObserver(() => {
      if (getResponseCount() <= initialCount) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (triggered) return;
        // まだ生成中かチェック（"..." スピナーが消えるのを待つ）
        if (deepQuery('.loading-indicator, [aria-busy="true"]')) {
          debounceTimer = setTimeout(arguments.callee, 1000);
          return;
        }
        triggered = true;
        observer.disconnect();

        const latestText = getText();
        console.log('[Gemini Sync] response captured:', latestText.slice(0, 100));

        if (!latestText) {
          showToast('⚠️ Gemini回答の取得失敗', 'warning');
          return;
        }

        GM_xmlhttpRequest({
          method: 'POST', url: SERVER_URL + '/',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ text: `## Geminiの回答:\n\n${latestText}` }),
          onload: (res) => {
            if (res.status === 200) showToast('✅ Gemini→Claude 送信完了', 'success');
            else showToast('❌ 送信失敗: ' + res.status, 'error');
          },
          onerror: () => showToast('❌ サーバーエラー', 'error'),
        });
      }, 4000);
    });

    observer.observe(container, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { observer.disconnect(); }, 120000);
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

      // 1st try: execCommand（Quill標準の方法、ブラウザイベントを正しく発火）
      try {
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, text);
        if (ok) {
          console.log('[Gemini Sync] text set via execCommand');
          showToast('✅ 入力セット(execCommand)', 'success');
          return true;
        }
      } catch (e) {
        console.warn('[Gemini Sync] execCommand failed:', e);
      }

      // 2nd try: DataTransfer paste（execCommand非対応環境）
      try {
        editor.focus();
        document.execCommand('selectAll', false, null);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        console.log('[Gemini Sync] text set via paste event');
        showToast('✅ 入力セット(paste)', 'success');
        return true;
      } catch (e) {
        console.warn('[Gemini Sync] paste failed:', e);
      }

      // 3rd try: textContent直接 + InputEvent
      const p = editor.querySelector('p') || editor;
      p.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[Gemini Sync] text set via textContent');
      showToast('✅ 入力セット(textContent)', 'success');
      return true;
    }

    // textarea フォールバック
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
})();
