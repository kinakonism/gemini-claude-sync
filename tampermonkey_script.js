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

  // ---- 2重初期化ガード（SPA対策） ----
  if (window.__geminiSyncInit) return;
  window.__geminiSyncInit = true;

  const SERVER_URL = 'http://localhost:3000';

  // ---- 差分送信: 前回送った要素数を記録、URL変更でリセット ----
  let lastSentCount = 0;
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastSentCount = 0;
    }
  }, 1000);

  // ---- UI ボタンを画面に追加 ----
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: sans-serif;
  `;

  const btnStyle = `
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: bold;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    transition: opacity 0.2s;
  `;

  // 【Gemini → Claude】現在の会話をサーバーへ送信
  const sendBtn = document.createElement('button');
  sendBtn.textContent = '📤 Gemini → Claude';
  sendBtn.style.cssText = btnStyle + 'background: #4285F4; color: white;';

  sendBtn.addEventListener('click', () => {
    const text = extractGeminiConversation();
    if (!text) { showToast('⚠️ 会話テキストが見つかりませんでした', 'warning'); return; }
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER_URL + '/',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ text }),
      onload: (res) => {
        if (res.status === 200) {
          showToast('⚡ Claude Code 実行中...', 'warning');
          sendBtn.textContent = '⏳ 処理中...';
          sendBtn.disabled = true;
          pollUntilDone();
        } else {
          showToast('❌ 送信失敗: ' + res.status, 'error');
        }
      },
      onerror: () => showToast('❌ サーバーに接続できません', 'error'),
    });
  });

  // 【Claude → Gemini】Claudeの出力を入力欄にセット
  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = '📥 Claude → Gemini';
  fetchBtn.style.cssText = btnStyle + 'background: #34A853; color: white;';

  fetchBtn.addEventListener('click', () => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SERVER_URL + '/',
      onload: (res) => {
        if (res.status === 200) {
          const data = JSON.parse(res.responseText);
          setGeminiInput(data.text);
          showToast('✅ Claudeの出力を入力欄にセットしました！', 'success');
        }
      },
      onerror: () => showToast('❌ サーバーに接続できません', 'error'),
    });
  });

  panel.appendChild(sendBtn);
  panel.appendChild(fetchBtn);
  document.body.appendChild(panel);

  // ---- WebSocket接続（push・Claude完了をリアルタイム受信） ----
  let ws = null;
  let wsReady = false;

  function connectWebSocket() {
    ws = new WebSocket('ws://localhost:3000');

    ws.onopen = () => {
      wsReady = true;
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // ターミナルからのpushを受信 → Geminiに自動送信
      if (data.type === 'push') {
        showToast('📨 ターミナルから受信、Geminiに送信中...', 'warning');
        setGeminiInput(data.text);
        setTimeout(() => {
          const submitBtn = [
            'button[aria-label="送信"]', 'button[aria-label="Send message"]',
            'button[data-mat-icon-name="send"]', 'button[jsname="Qx7uuf"]', '.send-button',
          ].map(sel => document.querySelector(sel)).find(Boolean);
          if (submitBtn) {
            submitBtn.click();
            showToast('🚀 送信完了。Geminiの回答を待っています...', 'success');
            watchForGeminiResponse();
          } else {
            showToast('⚠️ 送信ボタンが見つかりません', 'warning');
          }
        }, 500);
      }

      // Claude完了通知 → 入力欄にセット
      if (data.type === 'claude_done' && data.status === 'done') {
        sendBtn.textContent = '📤 Gemini → Claude';
        sendBtn.disabled = false;
        if (data.text) {
          setGeminiInput(data.text);
          showToast('✅ Claudeの回答を入力欄にセットしました！', 'success');
        }
      }
    };

    ws.onclose = () => {
      wsReady = false;
      // 5秒後に再接続
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = () => { ws.close(); };
  }

  connectWebSocket();

  // ---- Claudeの完了をポーリング（WebSocket未接続時のフォールバック） ----
  function pollUntilDone() {
    if (wsReady) return; // WebSocket接続中はポーリング不要
    const interval = setInterval(() => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: SERVER_URL + '/status',
        onload: (res) => {
          if (res.status !== 200) return;
          const { status } = JSON.parse(res.responseText);
          if (status === 'done') {
            clearInterval(interval);
            sendBtn.textContent = '📤 Gemini → Claude';
            sendBtn.disabled = false;
            GM_xmlhttpRequest({
              method: 'GET',
              url: SERVER_URL + '/',
              onload: (res2) => {
                if (res2.status === 200) {
                  const data = JSON.parse(res2.responseText);
                  setGeminiInput(data.text);
                  showToast('✅ Claudeの回答を入力欄にセットしました！', 'success');
                }
              },
            });
          }
        },
      });
    }, 2000);
  }


  // ---- Geminiの回答が完了したらClaudeに自動送信（ラウンドトリップ） ----
  function watchForGeminiResponse() {
    const container = document.querySelector('chat-history, .conversation-container, main');
    if (!container) return;

    const initialCount = document.querySelectorAll('model-response, message-content').length;
    let debounceTimer = null;
    let triggered = false;

    const observer = new MutationObserver(() => {
      const currentCount = document.querySelectorAll('model-response, message-content').length;
      if (currentCount <= initialCount) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (triggered) return;
        triggered = true;
        observer.disconnect();

        const responses = document.querySelectorAll('model-response .markdown, message-content');
        const latestText = responses[responses.length - 1]?.innerText?.trim();
        if (!latestText) return;

        GM_xmlhttpRequest({
          method: 'POST',
          url: SERVER_URL + '/',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ text: `## Geminiの回答:\n\n${latestText}` }),
          onload: () => showToast('🔄 Geminiの回答をClaudeに送信しました', 'success'),
          onerror: () => {},
        });
      }, 2500);
    });

    observer.observe(container, { childList: true, subtree: true, characterData: true });
    setTimeout(() => observer.disconnect(), 90000);
  }

  // ---- Geminiの会話テキストを抽出（差分のみ） ----
  function extractGeminiConversation() {
    const selectors = ['model-response .markdown', '.response-content', 'message-content', '[data-message-role]'];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length === 0) continue;

      const newNodes = Array.from(nodes).slice(lastSentCount);
      if (newNodes.length === 0) {
        showToast('⚠️ 前回から新しいメッセージがありません', 'warning');
        return null;
      }

      const prefix = lastSentCount === 0 ? '' : `## 追加メッセージ（${lastSentCount + 1}件目〜）\n\n`;
      const text = newNodes.map(n => n.innerText.trim()).filter(t => t.length > 0).join('\n\n---\n\n');
      lastSentCount = nodes.length;
      return prefix + text;
    }
    const body = document.body.innerText;
    return body.length > 100 ? body.substring(0, 8000) : null;
  }

  // ---- Geminiの入力欄にテキストをセット ----
  function setGeminiInput(text) {
    const selectors = ['rich-textarea .ql-editor', 'textarea[aria-label]', '[contenteditable="true"]', 'rich-textarea'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, text);
        } else {
          el.innerText = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    navigator.clipboard.writeText(text).then(() => {
      showToast('⚠️ 入力欄が見つからないためクリップボードにコピーしました', 'warning');
    });
  }

  // ---- トースト通知 ----
  function showToast(message, type = 'success') {
    const colors = { success: '#34A853', error: '#EA4335', warning: '#FBBC04' };
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 130px;
      right: 20px;
      z-index: 100000;
      background: ${colors[type] || colors.success};
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-family: sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }
})();
