// ==UserScript==
// @name         Gemini <-> Claude Code Bi-directional Sync v4.0
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Web版GeminiとClaude Codeの双方向コンテキスト同期（Claude自動実行対応）
// @author       User
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    http://localhost:3000/tampermonkey_script.user.js
// @downloadURL  http://localhost:3000/tampermonkey_script.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'http://localhost:3000';

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
  sendBtn.title = 'Geminiの最新会話内容をローカルサーバー経由でgemini_ctx.mdに保存します';

  sendBtn.addEventListener('click', () => {
    const text = extractGeminiConversation();
    if (!text) {
      showToast('⚠️ 会話テキストが見つかりませんでした', 'warning');
      return;
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER_URL,
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
      onerror: () => showToast('❌ サーバーに接続できません（node server.js は起動中？）', 'error'),
    });
  });

  // Claudeの完了をポーリングして自動受信
  function pollUntilDone() {
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
            autoReceive();
          }
        },
      });
    }, 2000);
  }

  // 完了後に自動でClaude出力を入力欄にセット
  function autoReceive() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SERVER_URL,
      onload: (res) => {
        if (res.status === 200) {
          const data = JSON.parse(res.responseText);
          setGeminiInput(data.text);
          showToast('✅ Claudeの回答を入力欄にセットしました！', 'success');
        }
      },
    });
  }

  // 【Claude → Gemini】Claudeの出力を入力欄にセット
  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = '📥 Claude → Gemini';
  fetchBtn.style.cssText = btnStyle + 'background: #34A853; color: white;';
  fetchBtn.title = 'claude_out.mdの内容をGeminiの入力欄にセットします';

  fetchBtn.addEventListener('click', () => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SERVER_URL,
      onload: (res) => {
        if (res.status === 200) {
          try {
            const data = JSON.parse(res.responseText);
            setGeminiInput(data.text);
            showToast('✅ Claudeの出力を入力欄にセットしました！', 'success');
          } catch (e) {
            showToast('❌ レスポンスのパースに失敗しました', 'error');
          }
        } else {
          showToast('❌ 取得失敗: ' + res.status, 'error');
        }
      },
      onerror: () => showToast('❌ サーバーに接続できません（node server.js は起動中？）', 'error'),
    });
  });

  panel.appendChild(sendBtn);
  panel.appendChild(fetchBtn);
  document.body.appendChild(panel);

  // ---- 同期アーティファクトを除去 ----
  // gemini_ctx.md の内容が Gemini 画面に表示され、次の送信時に拾われる入れ子問題を防ぐ
  function stripSyncArtifacts(text) {
    const lines = text.split('\n');
    const result = [];
    let skipping = false;

    for (const line of lines) {
      // "### Gemini Context (..." で始まるブロックに入ったらスキップ開始
      if (/^### Gemini Context \(/.test(line)) {
        skipping = true;
      }
      // スキップ中でも次の本来の会話見出し（👤 / 🤖）が来たら再開
      if (skipping && /^### (👤|🤖)/.test(line)) {
        skipping = false;
      }
      if (!skipping) {
        result.push(line);
      }
    }

    return result.join('\n').trim();
  }

  // ---- Gemini の会話テキストを抽出 ----
  function extractGeminiConversation() {
    // Geminiのメッセージバブルを取得（構造変化に備えて複数セレクタを試行）
    const selectors = [
      'model-response .markdown',
      '.response-content',
      'message-content',
      '[data-message-role]',
      '.conversation-container',
    ];

    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) {
        const raw = Array.from(nodes)
          .map(n => n.innerText.trim())
          .filter(t => t.length > 0)
          .join('\n\n---\n\n');
        return stripSyncArtifacts(raw);
      }
    }

    // フォールバック: ページ全体の表示テキストから取得
    const body = document.body.innerText;
    return body.length > 100 ? stripSyncArtifacts(body.substring(0, 8000)) : null;
  }

  // ---- Gemini の入力欄にテキストをセット ----
  function setGeminiInput(text) {
    const selectors = [
      'rich-textarea .ql-editor',
      'textarea[aria-label]',
      '[contenteditable="true"]',
      'rich-textarea',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.focus();
        if (el.tagName === 'TEXTAREA') {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.innerText = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
    }
    // 入力欄が見つからなければクリップボードにコピー
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
      animation: fadeIn 0.3s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }
})();
