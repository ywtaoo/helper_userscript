// ==UserScript==
// @name         Trading Discipline Panel
// @namespace    trading-discipline
// @version      0.2.1
// @updateURL    https://ywtaoo.github.io/helper_userscript/trading-discipline.user.js
// @downloadURL  https://ywtaoo.github.io/helper_userscript/trading-discipline.user.js
// @description  ES/NQ/GC 日内交易纪律辅助系统 — DOM 抓取 + 状态面板 + 风险提醒
// @author       hoho
// @match        https://www.tradingview.com/chart/*
// @match        https://www.tradingview.com/chart*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-start
// @connect      localhost
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Configuration
  // ============================================================
  const API_BASE = 'http://localhost:18080/api';
  const REFRESH_INTERVAL = 30000; // 30s panel refresh
  const RETRY_QUEUE_KEY = 'td_retry_queue';

  // ============================================================
  // 1. DOM Scraper — Orders > Filled Tab (M2)
  // ============================================================
  //
  // TradingView's Tradovate integration is server-side — the browser never
  // makes XHR/Fetch calls to tradovateapi.com. Instead, we scrape the
  // Account Manager's "Orders > Filled" table which persists all filled orders.
  //
  // Confirmed selectors from live DOM inspection (2026-03-02):
  //   Table:   table[data-name="TRADOVATE.orders-table"]
  //   Rows:    tbody tr.ka-row  (data-row-id = Order ID)
  //   Cells:   td[data-label="<name>"] .ka-cell-text
  //   Symbol:  td[data-label="Symbol"] .titleContent-oThzYPsJ  (special wrapper)

  const FILLED_TABLE_SEL    = 'table[data-name="TRADOVATE.orders-table"]';
  const ACCOUNT_MANAGER_SEL = '.accountManager-vCXUCd2i';
  const SCRAPE_INTERVAL_MS  = 5000; // poll every 5s

  // Track seen Order IDs to avoid duplicate submissions
  const seenOrderIds = new Set();
  let scraperObserver = null;

  /**
   * Wait for the Account Manager to appear in the DOM, then call callback.
   */
  function waitForAccountManager(callback) {
    const el = document.querySelector(ACCOUNT_MANAGER_SEL);
    if (el) { callback(el); return; }

    const observer = new MutationObserver(() => {
      const found = document.querySelector(ACCOUNT_MANAGER_SEL);
      if (found) { observer.disconnect(); callback(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Start the DOM scraper: interval polling + MutationObserver for fast detection.
   */
  function startScraper() {
    console.log('[TD] 🔍 DOM scraper starting — watching Orders > Filled table');

    // Interval-based polling as the primary mechanism
    setInterval(pollFilledOrders, SCRAPE_INTERVAL_MS);

    // MutationObserver for faster detection when new rows are added
    waitForAccountManager((container) => {
      scraperObserver = new MutationObserver(pollFilledOrders);
      scraperObserver.observe(container, { childList: true, subtree: true });
      console.log('[TD] 🔍 MutationObserver attached to Account Manager');
    });

    // Immediate first poll
    pollFilledOrders();
  }

  /**
   * Scan the Filled orders table for new rows and forward any new fills.
   */
  function pollFilledOrders() {
    const table = document.querySelector(FILLED_TABLE_SEL);
    if (!table) return;

    const rows = table.querySelectorAll('tbody tr.ka-row');
    if (!rows.length) return;

    for (const row of rows) {
      const orderId = row.dataset.rowId;
      if (!orderId || seenOrderIds.has(orderId)) continue;

      const fillData = scrapeOrderRow(row, orderId);
      if (fillData) {
        seenOrderIds.add(orderId);
        console.log('[TD] 📌 New filled order detected:', fillData);
        forwardToBackend(fillData);
      }
    }
  }

  /**
   * Extract fill data from a single <tr> row in the Filled orders table.
   * Returns a normalized fill payload or null if data is incomplete.
   */
  function scrapeOrderRow(row, orderId) {
    try {
      // Symbol uses a special wrapper element — not plain .ka-cell-text
      const symbolEl = row.querySelector('.titleContent-oThzYPsJ');
      const symbol = symbolEl?.textContent?.trim() || '';

      // Side: "Buy" or "Sell"
      const sideEl = row.querySelector('[data-label="Side"] .ka-cell-text');
      const side = sideEl?.textContent?.trim() || '';

      // Filled Qty (use Filled Qty not Qty — handles partial fills)
      const filledQtyEl = row.querySelector('[data-label="Filled Qty"] .ka-cell-text');
      const filledQty = parseFloat(filledQtyEl?.textContent?.trim() || '0');

      // Avg Fill Price — strip commas before parsing (e.g. "5,348.0" → 5348.0)
      const avgPriceEl = row.querySelector('[data-label="Avg Fill Price"] .ka-cell-text');
      const avgPrice = parseFloat((avgPriceEl?.textContent?.trim() || '0').replace(/,/g, ''));

      // Update Time — TradingView shows "YYYY-MM-DD HH:MM:SS" (exchange/ET time)
      const timeEl = row.querySelector('[data-label="Update Time"] .ka-cell-text');
      const timeText = timeEl?.textContent?.trim() || '';
      // Parse as local time (browser timezone) — Tradovate shows user-local time
      const timestamp = timeText
        ? new Date(timeText.replace(' ', 'T')).toISOString()
        : new Date().toISOString();

      // Order type (informational only)
      const typeEl = row.querySelector('[data-label="Type"] .ka-cell-text');
      const orderType = typeEl?.textContent?.trim() || '';

      // Validate required fields
      if (!symbol || !side || filledQty <= 0 || isNaN(avgPrice) || avgPrice <= 0) {
        console.warn('[TD] Incomplete row — skipping:', { orderId, symbol, side, filledQty, avgPrice });
        return null;
      }

      return {
        fill_id:  parseInt(orderId, 10), // backend expects number; Order IDs fit within MAX_SAFE_INTEGER
        symbol:   symbol,
        action:   side,       // "Buy" or "Sell"
        qty:      filledQty,
        price:    avgPrice,
        timestamp: timestamp,
        raw: {
          order_id:    orderId,
          symbol:      symbol,
          side:        side,
          order_type:  orderType,
          filled_qty:  filledQty,
          avg_price:   avgPrice,
          update_time: timeText,
        },
      };
    } catch (e) {
      console.error('[TD] Error scraping order row:', e);
      return null;
    }
  }

  /**
   * Forward a normalized fill payload to the local backend.
   */
  function forwardToBackend(fillData) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${API_BASE}/events`,
      data: JSON.stringify(fillData),
      headers: { 'Content-Type': 'application/json' },
      onload: (res) => {
        if (res.status >= 200 && res.status < 300) {
          console.log('[TD] ✅ Fill event sent to backend:', fillData.fill_id);
          refreshStatus();
        } else {
          console.error('[TD] ❌ Backend rejected:', res.responseText);
          queueForRetry(fillData);
        }
      },
      onerror: (err) => {
        console.error('[TD] ❌ Backend unreachable:', err);
        queueForRetry(fillData);
      },
    });
  }

  // ============================================================
  // 2. Retry Queue (降级处理)
  // ============================================================

  function queueForRetry(fillData) {
    try {
      const queue = JSON.parse(localStorage.getItem(RETRY_QUEUE_KEY) || '[]');
      queue.push({ data: fillData, attempts: 0, timestamp: Date.now() });
      localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(queue));
      console.log(`[TD] Queued for retry (${queue.length} pending)`);
    } catch (e) {
      console.error('[TD] Failed to queue for retry:', e);
    }
  }

  function processRetryQueue() {
    try {
      const queue = JSON.parse(localStorage.getItem(RETRY_QUEUE_KEY) || '[]');
      if (queue.length === 0) return;

      const remaining = [];
      for (const item of queue) {
        if (item.attempts >= 3) {
          console.warn('[TD] Dead letter — max retries exceeded:', item.data);
          continue;
        }

        item.attempts++;
        GM_xmlhttpRequest({
          method: 'POST',
          url: `${API_BASE}/events`,
          data: JSON.stringify(item.data),
          headers: { 'Content-Type': 'application/json' },
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              console.log('[TD] ✅ Retry successful');
            }
          },
          onerror: () => {
            remaining.push(item);
          },
        });
      }

      localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(remaining));
    } catch (e) {
      console.error('[TD] Retry queue error:', e);
    }
  }

  // Retry every 60s
  setInterval(processRetryQueue, 60000);

  // ============================================================
  // 3. Panel UI (M3)
  // ============================================================

  let panelEl = null;
  let lastStatus = null;
  let lastUpdateTime = null;
  let isCollapsed = localStorage.getItem('td_panel_collapsed') === 'true';
  let panelPos = JSON.parse(localStorage.getItem('td_panel_pos') || '{"top":"80px","right":"80px","left":""}');

  function initPanel() {
    // Wait for page to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createPanel);
    } else {
      // Small delay to let TradingView UI settle
      setTimeout(createPanel, 2000);
    }
  }

  function createPanel() {
    // Inject styles
    GM_addStyle(`
      #td-panel {
        position: fixed;
        width: 250px;
        padding: 14px 16px;
        background: rgba(22, 22, 30, 0.96);
        color: #c8c8d0;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        backdrop-filter: blur(12px);
        z-index: 99999;
        font-family: 'Inter', 'SF Pro Text', -apple-system, sans-serif;
        font-size: 13px;
        line-height: 1.6;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        user-select: none;
        box-sizing: border-box;
      }
      #td-panel.td-collapsed .td-content {
        display: none;
      }
      #td-panel.td-collapsed {
        padding-bottom: 6px;
      }
      #td-panel .td-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: grab;
        padding-bottom: 8px;
        margin-bottom: 0;
      }
      #td-panel .td-header:active {
        cursor: grabbing;
      }
      #td-panel:not(.td-collapsed) .td-header {
        margin-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .td-header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .td-collapse-btn {
        cursor: pointer;
        opacity: 0.5;
        transition: opacity 0.2s;
        font-size: 10px;
      }
      .td-collapse-btn:hover {
        opacity: 1;
      }
      #td-panel .td-title {
        font-size: 13px;
        font-weight: 600;
        color: #e4e4ed;
        letter-spacing: 0.3px;
      }
      #td-panel .td-risk-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: inline-block;
        transition: background 0.3s;
      }
      #td-panel .td-risk-green { background: #2ecc71; }
      #td-panel .td-risk-red { background: #e74c3c; }
      #td-panel .td-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
      }
      #td-panel .td-label {
        color: #8888a0;
        font-size: 12px;
      }
      #td-panel .td-value {
        font-weight: 600;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      #td-panel .td-positive { color: #2ecc71; }
      #td-panel .td-negative { color: #e74c3c; }
      #td-panel .td-orange { color: #f39c12; }
      #td-panel .td-neutral { color: #c8c8d0; }
      #td-panel .td-last5 {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 6px;
      }
      #td-panel .td-trade-chip {
        padding: 3px 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
      }
      #td-panel .td-chip-w { background: rgba(46, 204, 113, 0.15); color: #2ecc71; }
      #td-panel .td-chip-l { background: rgba(231, 76, 60, 0.15); color: #e74c3c; }
      #td-panel .td-chip-be { background: rgba(243, 156, 18, 0.15); color: #f39c12; }
      #td-panel .td-degraded {
        font-size: 10px;
        color: #666;
        text-align: center;
        padding-top: 6px;
      }

      /* Trade dots row */
      #td-panel .td-dots-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
      }
      #td-panel .td-dots {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      #td-panel .td-dot {
        font-size: 14px;
        line-height: 1;
      }
      #td-panel .td-dot-empty { color: #555; }
      #td-panel .td-dot-gold { color: #f1c40f; }
      #td-panel .td-dot-orange { color: #e67e22; }
      #td-panel .td-dot-red { color: #e74c3c; }
      #td-panel .td-dots-label {
        font-size: 11px;
        color: #8888a0;
      }

      /* Golden zone border */
      #td-panel.td-golden-border {
        box-shadow: 0 0 12px rgba(241, 196, 15, 0.35), 0 8px 32px rgba(0, 0, 0, 0.6);
        border-color: rgba(241, 196, 15, 0.3);
      }
      /* Golden complete banner */
      #td-panel .td-golden-msg {
        background: rgba(241, 196, 15, 0.1);
        border: 1px solid rgba(241, 196, 15, 0.25);
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        color: #f1c40f;
        text-align: center;
        margin: 8px 0 2px;
      }

      /* Trade limit modal (reuses risk modal pattern) */
      #td-limit-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
      }
      #td-limit-modal {
        background: #1a1a2e;
        border-radius: 12px;
        padding: 24px 28px;
        max-width: 420px;
        width: 90%;
        color: #e4e4ed;
        font-family: 'Inter', -apple-system, sans-serif;
      }
      #td-limit-modal.td-limit-overtime {
        border: 1px solid rgba(230, 126, 34, 0.3);
        box-shadow: 0 8px 40px rgba(230, 126, 34, 0.2);
      }
      #td-limit-modal.td-limit-red {
        border: 1px solid rgba(231, 76, 60, 0.3);
        box-shadow: 0 8px 40px rgba(231, 76, 60, 0.2);
      }
      #td-limit-modal .td-modal-icon {
        font-size: 32px;
        text-align: center;
        margin-bottom: 12px;
      }
      #td-limit-modal .td-modal-title {
        font-size: 16px;
        font-weight: 700;
        text-align: center;
        margin-bottom: 12px;
      }
      #td-limit-modal .td-limit-overtime .td-modal-title,
      #td-limit-modal.td-limit-overtime .td-modal-title { color: #e67e22; }
      #td-limit-modal.td-limit-red .td-modal-title { color: #e74c3c; }
      #td-limit-modal .td-modal-body {
        font-size: 13px;
        line-height: 1.7;
        color: #b0b0c0;
        margin-bottom: 20px;
      }
      #td-limit-modal .td-limit-reason {
        width: 100%;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 8px 10px;
        color: #e4e4ed;
        font-size: 13px;
        font-family: inherit;
        resize: vertical;
        min-height: 60px;
        margin-bottom: 16px;
        box-sizing: border-box;
      }
      #td-limit-modal .td-limit-reason::placeholder { color: #666; }
      #td-limit-modal .td-modal-btns {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }
      #td-limit-modal .td-btn {
        padding: 8px 20px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: opacity 0.2s;
      }
      #td-limit-modal .td-btn:hover { opacity: 0.85; }
      #td-limit-modal .td-btn-cancel {
        background: rgba(255, 255, 255, 0.1);
        color: #c8c8d0;
      }
      #td-limit-modal .td-btn-confirm {
        color: #fff;
      }
      #td-limit-modal.td-limit-overtime .td-btn-confirm { background: #e67e22; }
      #td-limit-modal.td-limit-red .td-btn-confirm { background: #e74c3c; }
      #td-limit-modal .td-btn-confirm:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      #td-panel .td-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.06);
        margin: 10px 0;
      }

      /* Annotation button in panel */
      #td-panel .td-anno-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        padding: 7px 0;
        margin-top: 8px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: #b0b0c0;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s, color 0.2s;
        font-family: inherit;
      }
      #td-panel .td-anno-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #e4e4ed;
      }
      #td-panel .td-anno-badge {
        background: #e67e22;
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 8px;
        min-width: 16px;
        text-align: center;
      }

      /* Annotation Overlay & Modal */
      .td-anno-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.75);
        z-index: 100001;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
      }
      .td-anno-modal {
        background: #1a1a2e;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        padding: 20px 24px;
        max-width: 480px;
        width: 92%;
        color: #e4e4ed;
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 13px;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.7);
      }
      .td-anno-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .td-anno-modal-title {
        font-size: 15px;
        font-weight: 700;
      }
      .td-anno-close {
        cursor: pointer;
        font-size: 18px;
        color: #888;
        background: none;
        border: none;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.2s;
      }
      .td-anno-close:hover { color: #e4e4ed; }

      /* Trade navigator */
      .td-anno-nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        margin-bottom: 14px;
        background: rgba(255, 255, 255, 0.04);
        border-radius: 8px;
        gap: 8px;
      }
      .td-anno-nav-arrow {
        cursor: pointer;
        font-size: 16px;
        color: #888;
        background: none;
        border: none;
        padding: 2px 8px;
        border-radius: 4px;
        transition: background 0.2s, color 0.2s;
      }
      .td-anno-nav-arrow:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        color: #e4e4ed;
      }
      .td-anno-nav-arrow:disabled {
        opacity: 0.3;
        cursor: default;
      }
      .td-anno-nav-info {
        text-align: center;
        flex: 1;
      }
      .td-anno-nav-counter {
        font-size: 11px;
        color: #888;
        margin-bottom: 2px;
      }
      .td-anno-nav-trade {
        font-size: 13px;
        font-weight: 600;
      }
      .td-anno-nav-check {
        color: #2ecc71;
        margin-left: 6px;
      }

      /* Field rows */
      .td-anno-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 0;
        gap: 10px;
      }
      .td-anno-field-label {
        font-size: 12px;
        color: #8888a0;
        white-space: nowrap;
        min-width: 70px;
      }
      .td-anno-select {
        flex: 1;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 6px 10px;
        color: #e4e4ed;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        appearance: auto;
        max-width: 240px;
      }
      .td-anno-select:focus {
        outline: none;
        border-color: rgba(255, 255, 255, 0.25);
      }

      /* Multi-select trigger dropdown */
      .td-anno-multiselect {
        position: relative;
        flex: 1;
        max-width: 240px;
      }
      .td-anno-multiselect-display {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 4px 10px;
        min-height: 32px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        font-size: 13px;
        color: #8888a0;
      }
      .td-anno-multiselect-display:hover {
        border-color: rgba(255, 255, 255, 0.25);
      }
      .td-anno-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: rgba(230, 126, 34, 0.25);
        color: #e67e22;
        border-radius: 4px;
        padding: 2px 6px;
        font-size: 11px;
        white-space: nowrap;
      }
      .td-anno-chip-x {
        cursor: pointer;
        opacity: 0.7;
        font-size: 10px;
      }
      .td-anno-chip-x:hover { opacity: 1; }
      .td-anno-multiselect-dropdown {
        display: none;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        margin-top: 4px;
        background: #2a2a3e;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        overflow: hidden;
        z-index: 100001;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      }
      .td-anno-multiselect.open .td-anno-multiselect-dropdown {
        display: block;
      }
      .td-anno-multiselect-option {
        padding: 6px 10px;
        font-size: 12px;
        color: #b0b0c0;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .td-anno-multiselect-option:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .td-anno-multiselect-option.selected {
        color: #e67e22;
      }
      .td-anno-multiselect-check {
        width: 14px;
        text-align: center;
        font-size: 11px;
      }

      /* Discipline checks section */
      .td-anno-checks-title {
        font-size: 12px;
        font-weight: 600;
        color: #8888a0;
        margin: 12px 0 8px;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .td-anno-check-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 0;
        gap: 8px;
      }
      .td-anno-check-label {
        font-size: 12px;
        color: #b0b0c0;
        flex: 1;
      }
      .td-anno-btn-group {
        display: flex;
        gap: 4px;
      }
      .td-anno-btn-group button {
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: #888;
        transition: all 0.15s;
      }
      .td-anno-btn-group button:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #c8c8d0;
      }
      .td-anno-btn-active-yes {
        background: rgba(46, 204, 113, 0.2) !important;
        border-color: rgba(46, 204, 113, 0.4) !important;
        color: #2ecc71 !important;
      }
      .td-anno-btn-active-partial {
        background: rgba(243, 156, 18, 0.2) !important;
        border-color: rgba(243, 156, 18, 0.4) !important;
        color: #f39c12 !important;
      }
      .td-anno-btn-active-no {
        background: rgba(231, 76, 60, 0.2) !important;
        border-color: rgba(231, 76, 60, 0.4) !important;
        color: #e74c3c !important;
      }

      /* Score display */
      .td-anno-score {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 0;
        margin-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .td-anno-score-label {
        font-size: 13px;
        font-weight: 600;
        color: #8888a0;
      }
      .td-anno-score-value {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .td-anno-error-hint {
        font-size: 11px;
        color: #f39c12;
        font-style: italic;
      }

      /* Save button */
      .td-anno-save-btn {
        width: 100%;
        padding: 10px 0;
        margin-top: 12px;
        background: #3498db;
        border: none;
        border-radius: 8px;
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        transition: opacity 0.2s;
        font-family: inherit;
      }
      .td-anno-save-btn:hover { opacity: 0.85; }
      .td-anno-save-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      /* Risk Warning Modal */
      #td-risk-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(4px);
      }
      #td-risk-modal {
        background: #1a1a2e;
        border: 1px solid rgba(231, 76, 60, 0.3);
        border-radius: 12px;
        padding: 24px 28px;
        max-width: 420px;
        width: 90%;
        box-shadow: 0 8px 40px rgba(231, 76, 60, 0.2);
        color: #e4e4ed;
        font-family: 'Inter', -apple-system, sans-serif;
      }
      #td-risk-modal .td-modal-icon {
        font-size: 32px;
        text-align: center;
        margin-bottom: 12px;
      }
      #td-risk-modal .td-modal-title {
        font-size: 16px;
        font-weight: 700;
        color: #e74c3c;
        text-align: center;
        margin-bottom: 12px;
      }
      #td-risk-modal .td-modal-body {
        font-size: 13px;
        line-height: 1.7;
        color: #b0b0c0;
        margin-bottom: 20px;
      }
      #td-risk-modal .td-modal-extra {
        background: rgba(243, 156, 18, 0.1);
        border-left: 3px solid #f39c12;
        padding: 8px 12px;
        margin-bottom: 16px;
        font-size: 12px;
        color: #f39c12;
        border-radius: 0 6px 6px 0;
      }
      #td-risk-modal .td-modal-btns {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }
      #td-risk-modal .td-btn {
        padding: 8px 20px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: opacity 0.2s;
      }
      #td-risk-modal .td-btn:hover { opacity: 0.85; }
      #td-risk-modal .td-btn-cancel {
        background: rgba(255, 255, 255, 0.1);
        color: #c8c8d0;
      }
      #td-risk-modal .td-btn-confirm {
        background: #e74c3c;
        color: #fff;
      }
      #td-risk-modal .td-btn-confirm:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    `);

    // Create panel element
    panelEl = document.createElement('div');
    panelEl.id = 'td-panel';
    if (isCollapsed) panelEl.classList.add('td-collapsed');

    panelEl.style.top = panelPos.top;
    if (panelPos.left) panelEl.style.left = panelPos.left;
    if (panelPos.right) panelEl.style.right = panelPos.right;

    panelEl.innerHTML = buildPanelHTML(null);
    document.body.appendChild(panelEl);

    setupPanelInteractions();

    // Initial fetch
    refreshStatus();

    // Set up polling
    setInterval(refreshStatus, REFRESH_INTERVAL);

    console.log('[TD] 📊 Discipline panel initialized');
  }

  function buildPanelHTML(status) {
    if (!status) {
      return `
        <div class="td-header">
          <span class="td-title">📊 Discipline</span>
          <span class="td-risk-dot td-risk-green"></span>
        </div>
        <div class="td-degraded">Loading...</div>
      `;
    }

    const pnlClass = status.daily_net_pnl >= 0 ? 'td-positive' : 'td-negative';
    const pnlSign = status.daily_net_pnl >= 0 ? '+' : '';
    const riskClass = status.risk.state === 'red' ? 'td-risk-red' : 'td-risk-green';
    const scoreColor = status.discipline_score_color === 'orange' ? 'td-orange' : 'td-neutral';
    const scoreText = status.discipline_score_today !== null
      ? status.discipline_score_today.toFixed(0)
      : '—';

    // Trade dots
    const tl = status.trade_limit || { trades_today: 0, zone: 'waiting', golden_complete: false };
    const dotsHTML = buildTradeDotsHTML(tl);

    let last5HTML = '';
    if (status.last_5_trades && status.last_5_trades.length > 0) {
      last5HTML = status.last_5_trades.slice().reverse().map(t => {
        let chipClass = 'td-chip-be';
        if (t.result === 'W') chipClass = 'td-chip-w';
        if (t.result === 'L') chipClass = 'td-chip-l';
        const sign = t.pnl_net >= 0 ? '+' : '';
        return `<span class="td-trade-chip ${chipClass}">${t.result} ${sign}$${t.pnl_net.toFixed(0)}</span>`;
      }).join('');
    } else {
      last5HTML = '<span class="td-neutral">—</span>';
    }

    return `
      <div class="td-header">
        <span class="td-title">📊 Discipline</span>
        <div class="td-header-actions">
          <span class="td-risk-dot ${riskClass}" title="Risk: ${status.risk.state}"></span>
          <span class="td-collapse-btn" title="Toggle Panel">${isCollapsed ? '➕' : '➖'}</span>
        </div>
      </div>
      <div class="td-content">
      <div class="td-row">
        <span class="td-label">Today PnL</span>
        <span class="td-value ${pnlClass}">${pnlSign}$${status.daily_net_pnl.toFixed(2)}</span>
      </div>
      ${dotsHTML}
      ${tl.golden_complete ? '<div class="td-golden-msg">Perfect day — 考虑收工？</div>' : ''}
      <div class="td-divider"></div>
      <div>
        <div class="td-label" style="margin-bottom: 4px;">Last 5</div>
        <div class="td-last5">${last5HTML}</div>
      </div>
      <div class="td-divider"></div>
      <div class="td-row">
        <span class="td-label">Discipline</span>
        <span class="td-value ${scoreColor}">${scoreText}</span>
      </div>
      ${buildAnnoBtnHTML(status)}
      </div>
    `;
  }

  function buildTradeDotsHTML(tl) {
    const maxDots = 4;
    const count = tl.trades_today;
    const zone = tl.zone;

    let dots = '';
    for (let i = 0; i < maxDots; i++) {
      if (i < count) {
        let dotClass = 'td-dot-gold';
        if (zone === 'red') dotClass = 'td-dot-red';
        else if (zone === 'overtime') dotClass = i >= 2 ? 'td-dot-orange' : 'td-dot-gold';
        dots += `<span class="td-dot ${dotClass}">★</span>`;
      } else {
        dots += `<span class="td-dot td-dot-empty">○</span>`;
      }
    }

    let label = '';
    if (zone === 'waiting') label = '等待 setup...';
    else if (zone === 'golden') label = '';
    else if (zone === 'overtime') label = '⚠ 超出最佳区间';
    else if (zone === 'red') label = '■ 已达日限';

    return `
      <div class="td-dots-row">
        <div class="td-dots">${dots}</div>
        ${label ? `<span class="td-dots-label">${label}</span>` : ''}
      </div>
    `;
  }

  function setupPanelInteractions() {
    if (!panelEl) return;

    // Collapse toggle
    const toggleBtn = panelEl.querySelector('.td-collapse-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent drag
        isCollapsed = !isCollapsed;
        localStorage.setItem('td_panel_collapsed', isCollapsed);
        if (isCollapsed) {
          panelEl.classList.add('td-collapsed');
          toggleBtn.textContent = '➕';
        } else {
          panelEl.classList.remove('td-collapsed');
          toggleBtn.textContent = '➖';
        }
      });
    }

    // Drag functionality
    const header = panelEl.querySelector('.td-header');
    if (!header) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('.td-header-actions')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panelEl.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      // Clear right positioning to favor left based absolute positioning during drag
      panelEl.style.right = 'auto';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      panelEl.style.left = `${initialLeft + dx}px`;
      panelEl.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        // Save pos
        panelPos = {
          top: panelEl.style.top,
          left: panelEl.style.left,
          right: ''
        };
        localStorage.setItem('td_panel_pos', JSON.stringify(panelPos));
      }
    });
  }

  function isValidStatusPayload(status) {
    return (
      status &&
      typeof status.daily_net_pnl === 'number' &&
      typeof status.daily_gross_pnl === 'number' &&
      Array.isArray(status.last_5_trades) &&
      (status.discipline_score_color === 'normal' || status.discipline_score_color === 'orange') &&
      status.risk &&
      (status.risk.state === 'green' || status.risk.state === 'red') &&
      typeof status.risk.triggered === 'boolean' &&
      typeof status.risk.extra_warning === 'string' &&
      status.trade_limit &&
      typeof status.trade_limit.trades_today === 'number' &&
      typeof status.trade_limit.zone === 'string'
    );
  }

  function refreshStatus() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${API_BASE}/status`,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          console.error('[TD] Status request failed:', res.status, res.responseText);
          showDegraded(`HTTP ${res.status}`);
          return;
        }

        try {
          const status = JSON.parse(res.responseText);

          if (!isValidStatusPayload(status)) {
            console.error('[TD] Invalid status payload:', status);
            showDegraded('状态格式异常');
            return;
          }

          lastStatus = status;
          lastUpdateTime = new Date();

          if (panelEl) {
            panelEl.innerHTML = buildPanelHTML(status);
            setupPanelInteractions(); // Re-bind events after innerHTML replace
            setupAnnoBtn();

            // Golden border toggle
            if (status.trade_limit && status.trade_limit.golden_complete) {
              panelEl.classList.add('td-golden-border');
            } else {
              panelEl.classList.remove('td-golden-border');
            }
          }

          // Check for risk trigger
          if (status.risk.triggered && !riskAcknowledged) {
            showRiskWarning(status.risk.extra_warning);
          }

          // Check for trade limit warning
          checkTradeLimitWarning(status);
        } catch (e) {
          console.error('[TD] Failed to handle status response:', e, res.responseText);
          showDegraded('状态解析失败');
        }
      },
      onerror: () => {
        showDegraded('后端不可达');
      },
    });
  }

  function showDegraded(reason = '') {
    if (!panelEl) return;
    const reasonText = reason ? ` · ${reason}` : '';
    const timeStr = lastUpdateTime
      ? lastUpdateTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
      : '—';

    // Keep last successful data but show degraded notice.
    if (lastStatus) {
      panelEl.innerHTML = buildPanelHTML(lastStatus);
      const notice = document.createElement('div');
      notice.className = 'td-degraded';
      notice.textContent = `⚠ 数据暂不可用 · 最后更新 ${timeStr}${reasonText}`;
      panelEl.appendChild(notice);
      return;
    }

    // No successful status yet: replace initial loading state with explicit error.
    panelEl.innerHTML = `
      <div class="td-header">
        <span class="td-title">📊 Discipline</span>
        <span class="td-risk-dot td-risk-green"></span>
      </div>
      <div class="td-degraded">⚠ 数据暂不可用${reasonText}</div>
    `;
  }

  // ============================================================
  // 4. Risk Warning Modal (M4)
  // ============================================================

  let riskAcknowledged = false;
  let lastWarnedZone = 'none'; // 'none' | 'overtime' | 'red'

  function showRiskWarning(extraWarning) {
    // Don't show again if already acknowledged this session
    if (riskAcknowledged) return;

    // Don't show if overlay already exists
    if (document.getElementById('td-risk-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'td-risk-overlay';

    const extraHTML = extraWarning
      ? `<div class="td-modal-extra">${extraWarning}</div>`
      : '';

    overlay.innerHTML = `
      <div id="td-risk-modal">
        <div class="td-modal-icon">⚠️</div>
        <div class="td-modal-title">高情绪交易风险</div>
        <div class="td-modal-body">
          检测到你在过去1小时内连续2笔亏损。<br>
          当前处于高情绪交易风险区。<br><br>
          建议暂停并重新确认计划后再执行下一笔。
        </div>
        ${extraHTML}
        <div class="td-modal-btns">
          <button class="td-btn td-btn-cancel" id="td-risk-cancel">取消</button>
          <button class="td-btn td-btn-confirm" id="td-risk-confirm" disabled>确认继续 (5s)</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Cancel button — immediately available
    document.getElementById('td-risk-cancel').addEventListener('click', () => {
      overlay.remove();
    });

    // Confirm button — 5 second delay
    const confirmBtn = document.getElementById('td-risk-confirm');
    let countdown = 5;

    const timer = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        confirmBtn.textContent = `确认继续 (${countdown}s)`;
      } else {
        clearInterval(timer);
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认继续';
      }
    }, 1000);

    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.disabled) return;
      riskAcknowledged = true;
      overlay.remove();

      // Notify backend
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_BASE}/risk/acknowledge`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      });

      // Reset acknowledged flag after cooldown (allow re-trigger for new events)
      setTimeout(() => {
        riskAcknowledged = false;
        console.log('[TD] Risk modal cooldown completed');
      }, 30 * 60 * 1000); // 30 minutes cooldown (was 1 min)
    });
  }

  // ============================================================
  // 5. Trade Limit Warning Modal
  // ============================================================

  function showTradeLimitWarning(zone, count) {
    // Don't show if overlay already exists
    if (document.getElementById('td-limit-overlay')) return;

    const isRed = zone === 'red';
    const countdown = isRed ? 5 : 3;
    const zoneClass = isRed ? 'td-limit-red' : 'td-limit-overtime';
    const title = isRed ? '已达日交易上限' : '超出最佳交易区间';
    const icon = isRed ? '🛑' : '⚠️';
    const body = isRed
      ? `今日已 ${count} 笔交易。你正在偏离计划。<br>请输入继续的理由：`
      : `你已完成 ${count} 笔交易，最佳节奏是 1-2 笔。<br>确认继续？`;

    const reasonHTML = isRed
      ? '<textarea class="td-limit-reason" id="td-limit-reason" placeholder="为什么需要继续交易？"></textarea>'
      : '';

    const overlay = document.createElement('div');
    overlay.id = 'td-limit-overlay';

    overlay.innerHTML = `
      <div id="td-limit-modal" class="${zoneClass}">
        <div class="td-modal-icon">${icon}</div>
        <div class="td-modal-title">${title}</div>
        <div class="td-modal-body">${body}</div>
        ${reasonHTML}
        <div class="td-modal-btns">
          <button class="td-btn td-btn-cancel" id="td-limit-cancel">取消</button>
          <button class="td-btn td-btn-confirm" id="td-limit-confirm" disabled>确认继续 (${countdown}s)</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Cancel button
    document.getElementById('td-limit-cancel').addEventListener('click', () => {
      overlay.remove();
    });

    // Confirm button with countdown
    const confirmBtn = document.getElementById('td-limit-confirm');
    let remaining = countdown;

    const timer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        confirmBtn.textContent = `确认继续 (${remaining}s)`;
      } else {
        clearInterval(timer);
        // For red zone, only enable if reason is provided
        if (isRed) {
          const reasonEl = document.getElementById('td-limit-reason');
          if (reasonEl && reasonEl.value.trim().length > 0) {
            confirmBtn.disabled = false;
          }
          confirmBtn.textContent = '确认继续';
          // Listen for input changes to enable/disable
          if (reasonEl) {
            reasonEl.addEventListener('input', () => {
              confirmBtn.disabled = reasonEl.value.trim().length === 0;
            });
          }
        } else {
          confirmBtn.disabled = false;
          confirmBtn.textContent = '确认继续';
        }
      }
    }, 1000);

    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.disabled) return;
      lastWarnedZone = zone;
      overlay.remove();
    });
  }

  /**
   * Check if trade limit warning should fire based on zone escalation.
   */
  function checkTradeLimitWarning(status) {
    if (!status.trade_limit) return;
    const warning = status.trade_limit.show_warning;
    if (warning === 'none') return;

    // Only fire when escalating beyond last warned level
    const levels = { none: 0, overtime: 1, red: 2 };
    if (levels[warning] > levels[lastWarnedZone]) {
      showTradeLimitWarning(warning, status.trade_limit.trades_today);
    }
  }

  // ============================================================
  // 6. Annotation UI
  // ============================================================

  const PLAYBOOKS = ['iFVG', 'Unicorn', 'Saitama', 'Other', 'Untagged'];
  const PSYCH_STATES = ['Calm', 'Pressured', 'Impulsive', 'Fatigued'];
  const PSYCH_TRIGGERS = ['FOMO', 'Revenge', 'Hesitation', 'Overconfidence', 'Distraction', 'None'];
  const ERROR_TYPES = ['Untagged', 'Chase', 'Early Entry', 'Late Entry', 'Oversize', 'Move Stop', 'Add to Loser', 'Overtrade', 'Rule Violation', 'Bad Exit', 'Other'];
  const DC_KEYS = [
    { key: 'plan_before_entry',     label: '入场前有计划' },
    { key: 'position_within_risk',  label: '仓位符合风控' },
    { key: 'stop_set_not_widened',  label: '止损设置未放宽' },
    { key: 'no_add_to_loser',       label: '未向亏损加仓' },
    { key: 'no_impulse_after_loss', label: '亏后未冲动连开' },
  ];
  const DC_SCORE_MAP = { Yes: 2, Partial: 1, No: 0 };
  const DC_TO_ERROR = {
    stop_set_not_widened: 'Move Stop',
    no_add_to_loser: 'Add to Loser',
    no_impulse_after_loss: 'Overtrade',
  };

  let annoTrades = [];
  let annoIdx = 0;
  let annoForm = {};

  function buildAnnoBtnHTML(status) {
    const pending = status.pending_annotations || 0;
    if (pending === 0) {
      return '<button class="td-anno-btn" id="td-anno-open">📝 标注</button>';
    }
    return `<button class="td-anno-btn" id="td-anno-open">📝 标注 <span class="td-anno-badge">${pending}</span></button>`;
  }

  function setupAnnoBtn() {
    const btn = document.getElementById('td-anno-open');
    if (btn) {
      btn.addEventListener('click', openAnnotationModal);
    }
  }

  function openAnnotationModal() {
    if (document.querySelector('.td-anno-overlay')) return;

    // Fetch today's trades
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${API_BASE}/trades`,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) {
          console.error('[TD] Failed to fetch trades for annotation:', res.status);
          return;
        }
        try {
          const data = JSON.parse(res.responseText);
          annoTrades = data.trades || [];
          if (annoTrades.length === 0) {
            console.log('[TD] No trades to annotate');
            return;
          }
          // Start at first unannotated trade, or first trade
          annoIdx = annoTrades.findIndex(t => t.discipline_score === null);
          if (annoIdx === -1) annoIdx = 0;
          annoForm = {};
          renderAnnoModal();
        } catch (e) {
          console.error('[TD] Failed to parse trades:', e);
        }
      },
      onerror: (err) => {
        console.error('[TD] Failed to fetch trades:', err);
      },
    });
  }

  function loadFormFromTrade(trade) {
    const a = trade.annotations || {};
    const dc = a.discipline_checks || {};
    return {
      playbook: a.playbook || 'Untagged',
      psych_state: a.psych_state || '',
      psych_triggers: Array.isArray(a.psych_triggers) ? [...a.psych_triggers] : [],
      error_type: a.error_type || 'Untagged',
      plan_before_entry: dc.plan_before_entry || null,
      position_within_risk: dc.position_within_risk || null,
      stop_set_not_widened: dc.stop_set_not_widened || null,
      no_add_to_loser: dc.no_add_to_loser || null,
      no_impulse_after_loss: dc.no_impulse_after_loss || null,
    };
  }

  function calcLiveScore(form) {
    const vals = DC_KEYS.map(d => form[d.key]);
    if (vals.some(v => v === null || v === undefined)) return null;
    const total = vals.reduce((s, v) => s + (DC_SCORE_MAP[v] || 0), 0);
    return Math.round((total / 10) * 100);
  }

  function inferErrorHint(form) {
    if (form.error_type !== 'Untagged') return null;
    for (const [checkKey, errorType] of Object.entries(DC_TO_ERROR)) {
      if (form[checkKey] === 'No') return errorType;
    }
    return null;
  }

  function renderAnnoModal() {
    // Remove existing
    const existing = document.querySelector('.td-anno-overlay');
    if (existing) existing.remove();

    const trade = annoTrades[annoIdx];
    if (!trade) return;

    // Load form from trade data if not already edited
    if (!annoForm._loaded || annoForm._tradeId !== trade.trade_id) {
      annoForm = loadFormFromTrade(trade);
      annoForm._loaded = true;
      annoForm._tradeId = trade.trade_id;
    }

    const pnl = trade.realized_pnl_net !== null ? trade.realized_pnl_net : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const pnlColor = pnl >= 0 ? '#2ecc71' : '#e74c3c';
    const isAnnotated = trade.discipline_score !== null;
    const checkMark = isAnnotated ? '<span class="td-anno-nav-check">✓</span>' : '';

    const score = calcLiveScore(annoForm);
    const scoreText = score !== null ? score : '—';
    const scoreColor = score !== null ? (score >= 60 ? '#2ecc71' : score >= 40 ? '#f39c12' : '#e74c3c') : '#888';

    const errorHint = inferErrorHint(annoForm);
    const errorHintHTML = errorHint ? `<span class="td-anno-error-hint">← 推断: ${errorHint}</span>` : '';

    const isLast = annoIdx >= annoTrades.length - 1;
    const saveBtnText = isLast ? '保存并关闭' : '保存并下一笔';

    // Build select options
    const playbookOpts = PLAYBOOKS.map(p =>
      `<option value="${p}" ${annoForm.playbook === p ? 'selected' : ''}>${p}</option>`
    ).join('');

    const psychOpts = ['<option value="">—</option>'].concat(PSYCH_STATES.map(p =>
      `<option value="${p}" ${annoForm.psych_state === p ? 'selected' : ''}>${p}</option>`
    )).join('');

    const errorOpts = ERROR_TYPES.map(e =>
      `<option value="${e}" ${annoForm.error_type === e ? 'selected' : ''}>${e}</option>`
    ).join('');

    const selectedChips = annoForm.psych_triggers.length > 0 && !(annoForm.psych_triggers.length === 1 && annoForm.psych_triggers[0] === 'None')
      ? annoForm.psych_triggers.map(t => `<span class="td-anno-chip">${t}<span class="td-anno-chip-x" data-trigger="${t}">✕</span></span>`).join('')
      : '<span style="font-size:13px">—</span>';
    const triggerOptions = PSYCH_TRIGGERS.map(t => {
      const sel = annoForm.psych_triggers.includes(t) ? 'selected' : '';
      const check = annoForm.psych_triggers.includes(t) ? '✓' : '';
      return `<div class="td-anno-multiselect-option ${sel}" data-trigger="${t}"><span class="td-anno-multiselect-check">${check}</span>${t}</div>`;
    }).join('');
    const triggerHTML = `
      <div class="td-anno-multiselect" id="td-anno-triggers">
        <div class="td-anno-multiselect-display" id="td-anno-trigger-display">${selectedChips}</div>
        <div class="td-anno-multiselect-dropdown">${triggerOptions}</div>
      </div>`;

    const dcRows = DC_KEYS.map(d => {
      const val = annoForm[d.key];
      const btnHTML = ['Yes', 'Partial', 'No'].map(v => {
        const activeClass = val === v ? `td-anno-btn-active-${v.toLowerCase()}` : '';
        return `<button data-dc="${d.key}" data-val="${v}" class="${activeClass}">${v}</button>`;
      }).join('');
      return `
        <div class="td-anno-check-row">
          <span class="td-anno-check-label">${d.label}</span>
          <div class="td-anno-btn-group">${btnHTML}</div>
        </div>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'td-anno-overlay';
    overlay.innerHTML = `
      <div class="td-anno-modal">
        <div class="td-anno-modal-header">
          <span class="td-anno-modal-title">📝 今日交易标注</span>
          <button class="td-anno-close" id="td-anno-close">✕</button>
        </div>
        <div class="td-anno-nav">
          <button class="td-anno-nav-arrow" id="td-anno-prev" ${annoIdx === 0 ? 'disabled' : ''}>◄</button>
          <div class="td-anno-nav-info">
            <div class="td-anno-nav-counter">${annoIdx + 1} / ${annoTrades.length}</div>
            <div class="td-anno-nav-trade">
              ${trade.symbol} ${trade.side} <span style="color:${pnlColor}">${pnlSign}$${pnl.toFixed(2)}</span>${checkMark}
            </div>
          </div>
          <button class="td-anno-nav-arrow" id="td-anno-next" ${annoIdx >= annoTrades.length - 1 ? 'disabled' : ''}>►</button>
        </div>

        <div class="td-anno-field">
          <span class="td-anno-field-label">Playbook</span>
          <select class="td-anno-select" id="td-anno-playbook">${playbookOpts}</select>
        </div>
        <div class="td-anno-field">
          <span class="td-anno-field-label">心理状态</span>
          <select class="td-anno-select" id="td-anno-psych">${psychOpts}</select>
        </div>
        <div class="td-anno-field">
          <span class="td-anno-field-label">心理触发</span>
          ${triggerHTML}
        </div>
        <div class="td-anno-field">
          <span class="td-anno-field-label">错误类型</span>
          <select class="td-anno-select" id="td-anno-error">${errorOpts}</select>
          ${errorHintHTML}
        </div>

        <div class="td-anno-checks-title">纪律检查</div>
        ${dcRows}

        <div class="td-anno-score">
          <span class="td-anno-score-label">纪律分</span>
          <span class="td-anno-score-value" style="color:${scoreColor}" id="td-anno-score-val">${scoreText}</span>
        </div>

        <button class="td-anno-save-btn" id="td-anno-save">${saveBtnText}</button>
      </div>
    `;

    document.body.appendChild(overlay);
    setupAnnoModalEvents(overlay);
  }

  function setupAnnoModalEvents(overlay) {
    // Close
    overlay.querySelector('#td-anno-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // Navigation
    overlay.querySelector('#td-anno-prev').addEventListener('click', () => {
      if (annoIdx > 0) {
        annoIdx--;
        annoForm = {};
        renderAnnoModal();
      }
    });
    overlay.querySelector('#td-anno-next').addEventListener('click', () => {
      if (annoIdx < annoTrades.length - 1) {
        annoIdx++;
        annoForm = {};
        renderAnnoModal();
      }
    });

    // Playbook
    overlay.querySelector('#td-anno-playbook').addEventListener('change', (e) => {
      annoForm.playbook = e.target.value;
    });

    // Psych state
    overlay.querySelector('#td-anno-psych').addEventListener('change', (e) => {
      annoForm.psych_state = e.target.value || null;
    });

    // Psych triggers — multi-select dropdown
    const triggerContainer = overlay.querySelector('#td-anno-triggers');
    const triggerDisplay = overlay.querySelector('#td-anno-trigger-display');

    // Toggle dropdown open/close
    triggerDisplay.addEventListener('click', (e) => {
      // Don't toggle if clicking a chip remove button
      if (e.target.classList.contains('td-anno-chip-x')) return;
      triggerContainer.classList.toggle('open');
    });

    // Close dropdown when clicking outside
    overlay.addEventListener('click', (e) => {
      if (!triggerContainer.contains(e.target)) {
        triggerContainer.classList.remove('open');
      }
    });

    // Handle chip remove (×) clicks
    triggerDisplay.addEventListener('click', (e) => {
      if (!e.target.classList.contains('td-anno-chip-x')) return;
      const trigger = e.target.dataset.trigger;
      annoForm.psych_triggers = annoForm.psych_triggers.filter(t => t !== trigger);
      renderAnnoModal();
    });

    // Handle option clicks
    triggerContainer.querySelector('.td-anno-multiselect-dropdown').addEventListener('click', (e) => {
      const option = e.target.closest('.td-anno-multiselect-option');
      if (!option) return;
      const trigger = option.dataset.trigger;
      const isSelected = annoForm.psych_triggers.includes(trigger);

      if (isSelected) {
        annoForm.psych_triggers = annoForm.psych_triggers.filter(t => t !== trigger);
      } else {
        if (trigger === 'None') {
          annoForm.psych_triggers = ['None'];
        } else {
          annoForm.psych_triggers = annoForm.psych_triggers.filter(t => t !== 'None');
          annoForm.psych_triggers.push(trigger);
        }
      }
      renderAnnoModal();
    });

    // Error type
    overlay.querySelector('#td-anno-error').addEventListener('change', (e) => {
      annoForm.error_type = e.target.value;
    });

    // Discipline check buttons
    overlay.querySelectorAll('.td-anno-btn-group button').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.dc;
        const val = btn.dataset.val;
        // Toggle: click same value again → deselect
        annoForm[key] = annoForm[key] === val ? null : val;
        updateScoreDisplay(overlay);
        // Update button states in place
        btn.closest('.td-anno-btn-group').querySelectorAll('button').forEach(b => {
          b.className = '';
          if (b.dataset.val === annoForm[key]) {
            b.className = `td-anno-btn-active-${annoForm[key].toLowerCase()}`;
          }
        });
        // Update error hint
        updateErrorHint(overlay);
      });
    });

    // Save
    overlay.querySelector('#td-anno-save').addEventListener('click', () => {
      saveAnnotation(overlay);
    });
  }

  function updateScoreDisplay(overlay) {
    const score = calcLiveScore(annoForm);
    const el = overlay.querySelector('#td-anno-score-val');
    if (!el) return;
    if (score !== null) {
      el.textContent = score;
      el.style.color = score >= 60 ? '#2ecc71' : score >= 40 ? '#f39c12' : '#e74c3c';
    } else {
      el.textContent = '—';
      el.style.color = '#888';
    }
  }

  function updateErrorHint(overlay) {
    const hint = inferErrorHint(annoForm);
    const field = overlay.querySelector('#td-anno-error')?.closest('.td-anno-field');
    if (!field) return;
    const existingHint = field.querySelector('.td-anno-error-hint');
    if (existingHint) existingHint.remove();
    if (hint) {
      const span = document.createElement('span');
      span.className = 'td-anno-error-hint';
      span.textContent = `← 推断: ${hint}`;
      field.appendChild(span);
    }
  }

  function saveAnnotation(overlay) {
    const trade = annoTrades[annoIdx];
    if (!trade) return;

    const saveBtn = overlay.querySelector('#td-anno-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';

    const payload = {
      playbook: annoForm.playbook || 'Untagged',
      psych_state: annoForm.psych_state || null,
      psych_triggers: annoForm.psych_triggers.length > 0 ? annoForm.psych_triggers : [],
      error_type: annoForm.error_type || 'Untagged',
      discipline_checks: {},
    };
    DC_KEYS.forEach(d => {
      if (annoForm[d.key] !== null && annoForm[d.key] !== undefined) {
        payload.discipline_checks[d.key] = annoForm[d.key];
      }
    });

    GM_xmlhttpRequest({
      method: 'PATCH',
      url: `${API_BASE}/trades/${trade.trade_id}/annotations`,
      data: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      onload: (res) => {
        if (res.status >= 200 && res.status < 300) {
          console.log('[TD] ✅ Annotation saved for', trade.trade_id);

          // Update local trade data with response
          try {
            const updated = JSON.parse(res.responseText);
            annoTrades[annoIdx] = updated;
          } catch (e) { /* ignore parse error */ }

          const isLast = annoIdx >= annoTrades.length - 1;
          if (isLast) {
            overlay.remove();
          } else {
            annoIdx++;
            annoForm = {};
            renderAnnoModal();
          }

          // Refresh panel status
          refreshStatus();
        } else {
          console.error('[TD] ❌ Annotation save failed:', res.status, res.responseText);
          saveBtn.disabled = false;
          saveBtn.textContent = '保存失败 — 重试';
        }
      },
      onerror: (err) => {
        console.error('[TD] ❌ Annotation save error:', err);
        saveBtn.disabled = false;
        saveBtn.textContent = '保存失败 — 重试';
      },
    });
  }

  // ============================================================
  // Initialize
  // ============================================================

  initPanel();

  // Start DOM scraper after page settles (TV renders Account Manager lazily)
  setTimeout(startScraper, 3000);

  console.log('[TD] 🚀 Trading Discipline System initialized');

})();
