// ==UserScript==
// @name         Gemini <-> Claude Code Bi-directional Sync v5.0
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Web版GeminiとClaude Codeの双方向コンテキスト同期（ローダー版: 実ロジックはサーバから動的取得）
// @author       User
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    http://localhost:3000/tampermonkey_script.user.js
// @downloadURL  http://localhost:3000/tampermonkey_script.user.js
// ==/UserScript==

// このローダーは「サーバから /runtime.js を取得して eval」するだけ。
// すべての実ロジックは runtime.js に存在し、サーバ側で編集→Gemini画面の自動リロードで即時反映される。
// Tampermonkey のスクリプト更新は永久に不要（ローダー自体は変更頻度ゼロを目指す）。

(function () {
  'use strict';
  if (window.__geminiSyncLoaderInit) return;
  window.__geminiSyncLoaderInit = true;

  const SERVER_URL = 'http://localhost:3000';

  // GeminiはTrusted Typesを強制しており、eval(string) が直接ブロックされる。
  // 自前のTTポリシーを登録して TrustedScript に変換してからevalする。
  let scriptPolicy = null;
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      scriptPolicy = window.trustedTypes.createPolicy('gemini-sync-runtime', {
        createScript: (s) => s,
      });
    }
  } catch (e) {
    console.warn('[Gemini Sync Loader] TT policy create failed (will try raw eval):', e);
  }

  function execCode(code) {
    // 1st: TTポリシー経由
    if (scriptPolicy) {
      try { eval(scriptPolicy.createScript(code)); return true; }
      catch (e) { console.warn('[Gemini Sync Loader] policy eval failed:', e); }
    }
    // 2nd: 生 eval（TT未強制環境でのフォールバック）
    try { eval(code); return true; }
    catch (e) { console.error('[Gemini Sync Loader] raw eval failed:', e); }
    return false;
  }

  function loadRuntime() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SERVER_URL + '/runtime.js?t=' + Date.now(),
      onload: function (res) {
        if (res.status !== 200) {
          console.error('[Gemini Sync Loader] runtime fetch failed:', res.status);
          return;
        }
        const ok = execCode(res.responseText);
        if (ok) console.log('[Gemini Sync Loader] runtime loaded');
      },
      onerror: function () { console.error('[Gemini Sync Loader] cannot connect to server'); },
    });
  }

  loadRuntime();
})();
