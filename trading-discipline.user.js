// ==UserScript==
// @name         Trading Discipline Panel
// @namespace    trading-discipline
// @version      0.4.7
// @updateURL    https://ywtaoo.github.io/helper_userscript/trading-discipline.user.js
// @downloadURL  https://ywtaoo.github.io/helper_userscript/trading-discipline.user.js
// @description  ES/NQ/GC intraday trading discipline system — DOM scraping + status panel + risk alerts
// @author       hoho
// @match        https://www.tradingview.com/chart/*
// @match        https://www.tradingview.com/chart*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Configuration
  // ============================================================
  const API_BASE = 'https://localhost:18080/api';
  const REVIEW_PAGE_URL = 'https://localhost:18080/review/';
  const REFRESH_INTERVAL = 30000; // 30s panel refresh
  const RETRY_QUEUE_KEY = 'td_retry_queue';
  const PRE_ARM_DRAFT_KEY = 'td_pre_arm_draft';
  const ACCOUNT_MANAGER_WAIT_TIMEOUT_MS = 60000;
  const POLL_MIN_INTERVAL_MS = 400;
  const MAX_RETRY_ATTEMPTS = 3;
  const STATUS_REQUEST_TIMEOUT_MS = 8000;
  const EVENT_REQUEST_TIMEOUT_MS = 8000;
  const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
  const PENDING_REVIEW_TARGET_REFRESH_TTL_MS = 5 * 60 * 1000;
  const PLAN_ADHERENCE_OPTIONS = ['Yes', 'Partial', 'No'];
  const MINDSET_OPTIONS = ['Calm', 'FOMO', 'Revenge', 'Fatigued'];
  const ERROR_TYPES = ['Untagged', 'Chase', 'Early Entry', 'Late Entry', 'Oversize', 'Move Stop', 'Add to Loser', 'Overtrade', 'Rule Violation', 'Bad Exit', 'Other'];
  const IS_TEST_MODE = typeof globalThis !== 'undefined' && globalThis.__TD_TEST_MODE__ === true;
  const IS_MAC_PLATFORM = /Mac|iPhone|iPad|iPod/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform ||
    navigator.userAgent ||
    '',
  );
  const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
  }

  function createRequestError(message, status = 0, body = '') {
    const error = new Error(message);
    error.status = status;
    error.body = body;
    return error;
  }

  async function requestJson(method, path, options = {}) {
    const { data, headers = {}, timeout = DEFAULT_REQUEST_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        signal: controller.signal,
        headers: data === undefined
          ? headers
          : { 'Content-Type': 'application/json', ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!res.ok) {
        const text = await res.text();
        throw createRequestError(`HTTP ${res.status}`, res.status, text);
      }
      const text = await res.text();
      const trimmed = text.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        throw createRequestError('Invalid JSON response', res.status, text);
      }
    } catch (error) {
      if (error.name === 'AbortError') throw createRequestError('timeout');
      throw error;
    } finally {
      clearTimeout(timerId);
    }
  }

  function formatMoney(value, digits = 2) {
    if (value === null || value === undefined) return '—';
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    const sign = amount >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(amount).toFixed(digits)}`;
  }

  function formatClockTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  function trimToNull(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function getTradeResult(trade) {
    if (!trade) return '—';
    const rawPnl = trade.realized_pnl_net;
    if (rawPnl === null || rawPnl === undefined) return '—';
    const pnl = Number(rawPnl);
    if (!Number.isFinite(pnl)) return '—';
    if (trade.is_breakeven) return 'BE';
    return pnl > 0 ? 'W' : 'L';
  }

  function isLosingTrade(trade) {
    if (!trade) return false;
    const rawPnl = trade.realized_pnl_net;
    if (rawPnl === null || rawPnl === undefined) return false;
    const pnl = Number(rawPnl);
    return Number.isFinite(pnl) && pnl < 0;
  }

  function getNumericPnl(value) {
    if (value === null || value === undefined) return null;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
  }

  function isAnnotationIncomplete(trade) {
    const annotations = (trade && trade.annotations) || {};
    if (annotations.playbook === 'Untagged') {
      return true;
    }
    if (annotations.plan_adherence === null || annotations.plan_adherence === undefined) {
      return true;
    }
    if (annotations.mindset === null || annotations.mindset === undefined) {
      return true;
    }
    return isLosingTrade(trade) && annotations.error_type === 'Untagged';
  }

  function getSetupProgress(trade) {
    const setupChecks = trade && trade.annotations && Array.isArray(trade.annotations.setup_checks)
      ? trade.annotations.setup_checks
      : null;
    if (!setupChecks || setupChecks.length === 0) return null;
    const checked = setupChecks.filter(Boolean).length;
    return { checked, total: setupChecks.length };
  }

  function getSetupDisplay(trade) {
    const progress = getSetupProgress(trade);
    if (!progress) {
      return { text: '—', className: 'td-setup-none' };
    }

    if (progress.checked === progress.total) {
      return { text: `${progress.checked}/${progress.total} ✓`, className: 'td-setup-complete' };
    }

    return { text: `${progress.checked}/${progress.total} ⚠`, className: 'td-setup-partial' };
  }

  function cloneChecklistState(state) {
    return Array.isArray(state) ? state.map(Boolean) : [];
  }

  function areChecklistStatesEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!!a[i] !== !!b[i]) return false;
    }
    return true;
  }

  function calculateSetupAverage(trades) {
    const values = (Array.isArray(trades) ? trades : [])
      .map((trade) => trade && trade.annotations && trade.annotations.setup_completeness)
      .filter((value) => typeof value === 'number' && Number.isFinite(value));

    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function sortTradesForDisplay(trades) {
    return [...(Array.isArray(trades) ? trades : [])].sort((a, b) => {
      const aTime = (a.close_time || a.open_time || '');
      const bTime = (b.close_time || b.open_time || '');
      return bTime.localeCompare(aTime);
    });
  }

  function isEditableElement(target) {
    if (!target || !(target instanceof Element)) return false;
    const tagName = target.tagName ? target.tagName.toLowerCase() : '';
    return (
      target.isContentEditable ||
      tagName === 'input' ||
      tagName === 'textarea' ||
      tagName === 'select' ||
      !!target.closest('[contenteditable="true"]')
    );
  }

  function getRequestErrorMessage(error, fallback) {
    if (error && error.message === 'timeout') {
      return `${fallback} (timeout)`;
    }
    if (error && error.status) {
      return `${fallback} (${error.status})`;
    }
    if (error && error.statusText) {
      return `${fallback} (${error.statusText})`;
    }
    return fallback;
  }

  function formatPendingReviewLabel(count) {
    const safeCount = Number(count);
    if (!Number.isFinite(safeCount) || safeCount <= 0) return '';
    return safeCount === 1
      ? '1 day unreviewed'
      : `${Math.floor(safeCount)} days unreviewed`;
  }

  function getFirstPendingReviewDate(reviewDays) {
    if (!Array.isArray(reviewDays)) return null;
    const firstPending = reviewDays.find((item) => (
      item &&
      item.review_completed === false &&
      typeof item.trading_date === 'string' &&
      item.trading_date
    ));
    return firstPending ? firstPending.trading_date : null;
  }

  function shouldRefreshPendingReviewTarget(count, options = {}) {
    const safeCount = Number(count);
    if (!Number.isFinite(safeCount) || safeCount <= 0) return false;

    const {
      lastCount = pendingReviewTargetCount,
      lastFetchedAt = pendingReviewTargetFetchedAt,
      now = Date.now(),
      ttlMs = PENDING_REVIEW_TARGET_REFRESH_TTL_MS,
    } = options;

    if (lastCount !== safeCount) return true;
    if (!Number.isFinite(lastFetchedAt) || lastFetchedAt <= 0) return true;
    return now - lastFetchedAt >= ttlMs;
  }

  function buildReviewPageUrl(tradingDate) {
    if (typeof tradingDate !== 'string' || !tradingDate) {
      return REVIEW_PAGE_URL;
    }
    const encodedDate = encodeURIComponent(tradingDate);
    return `${REVIEW_PAGE_URL}?date=${encodedDate}`;
  }

  function buildPendingReviewBadgeHTML(status) {
    const label = formatPendingReviewLabel(status && status.pending_reviews);
    if (!label) return '';

    return `
      <button class="td-review-badge" id="td-review-open" title="${escapeHtml(label)}">
        ${escapeHtml(label)}
      </button>
    `;
  }

  function openReviewPage(tradingDate) {
    if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
      console.warn('[TD] Review page open skipped: document unavailable');
      return false;
    }

    const link = document.createElement('a');
    link.href = buildReviewPageUrl(tradingDate);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  function getPreArmShortcutLabel() {
    return IS_MAC_PLATFORM ? 'Cmd+S' : 'Alt+S';
  }

  function isPreArmShortcutEvent(event) {
    const key = event && typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 's') return false;
    return IS_MAC_PLATFORM ? !!event.metaKey : !!event.altKey;
  }

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
  const POSITIONS_TABLE_SEL = 'table[data-name="TRADOVATE.positions-table"]';
  const ACCOUNT_MANAGER_SEL = '.accountManager-vCXUCd2i';
  const SCRAPE_INTERVAL_MS  = 5000; // poll every 5s
  const SUPPORTED_SYMBOLS   = new Set(['ES', 'NQ', 'MES', 'MNQ', 'GC', 'MGC']);

  // Track the last submitted snapshot per order so cumulative fills can update in place.
  const sentOrderSnapshots = new Map();
  const pendingOrderSnapshots = new Map();
  const eventSendQueue = [];

  let scraperObserver = null;
  let accountManagerWaitObserver = null;
  let accountManagerWaitTimeoutId = null;
  let scraperIntervalId = null;
  let scraperStartTimeoutId = null;
  let pollDelayTimerId = null;
  let pollInProgress = false;
  let pollPending = false;
  let lastPollRunAt = 0;
  let lastFullScanAt = 0; // timestamp of last full (all-rows) scrape for partial-fill detection

  let retryIntervalId = null;
  let statusIntervalId = null;
  let panelInitTimeoutId = null;
  let isProcessingRetryQueue = false;
  let isSendingEvent = false;
  let isRefreshingStatus = false;
  let pendingStatusRefresh = false;
  let statusRefreshFailureCount = 0;
  let statusRefreshNextAllowedAt = 0;
  let lifecycleCleanupRegistered = false;
  let cleanedUp = false;

  function clearAccountManagerWaitObserver() {
    if (accountManagerWaitTimeoutId) {
      clearTimeout(accountManagerWaitTimeoutId);
      accountManagerWaitTimeoutId = null;
    }
    if (accountManagerWaitObserver) {
      accountManagerWaitObserver.disconnect();
      accountManagerWaitObserver = null;
    }
  }

  function stopScraper() {
    if (scraperIntervalId) {
      clearInterval(scraperIntervalId);
      scraperIntervalId = null;
    }
    if (scraperStartTimeoutId) {
      clearTimeout(scraperStartTimeoutId);
      scraperStartTimeoutId = null;
    }
    if (pollDelayTimerId) {
      clearTimeout(pollDelayTimerId);
      pollDelayTimerId = null;
    }
    if (scraperObserver) {
      scraperObserver.disconnect();
      scraperObserver = null;
    }
    clearAccountManagerWaitObserver();
    pollInProgress = false;
    pollPending = false;
  }

  function cleanupRuntime() {
    if (cleanedUp) return;
    cleanedUp = true;
    pendingStatusRefresh = false;
    stopScraper();
    if (retryIntervalId) {
      clearInterval(retryIntervalId);
      retryIntervalId = null;
    }
    if (statusIntervalId) {
      clearInterval(statusIntervalId);
      statusIntervalId = null;
    }
    if (panelInitTimeoutId) {
      clearTimeout(panelInitTimeoutId);
      panelInitTimeoutId = null;
    }
    unbindPanelInteractions();
    if (preArmShortcutBound) {
      document.removeEventListener('keydown', onPreArmShortcut, true);
      preArmShortcutBound = false;
    }
    closePreArmView();
    currentOpenPosition = null;
  }

  function registerLifecycleCleanup() {
    if (lifecycleCleanupRegistered) return;
    lifecycleCleanupRegistered = true;

    window.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      cleanupRuntime();
    });

    window.addEventListener('pageshow', (event) => {
      if (!event.persisted || cleanedUp) return;
      refreshStatus();
      schedulePoll();
    });

    window.addEventListener('beforeunload', cleanupRuntime, { once: true });
  }

  function buildOrderSnapshotKey(fillData) {
    if (!fillData) return '';
    return [
      fillData.fill_id,
      fillData.symbol || '',
      fillData.action || '',
      Number(fillData.qty) || 0,
      Number(fillData.price) || 0,
      fillData.timestamp || '',
    ].join('|');
  }

  function rememberSentOrderSnapshot(orderId, snapshotKey) {
    if (!orderId || !snapshotKey) return;
    sentOrderSnapshots.set(orderId, snapshotKey);
  }

  function setPendingOrderSnapshot(orderId, snapshotKey) {
    if (!orderId || !snapshotKey) return;
    pendingOrderSnapshots.set(orderId, snapshotKey);
  }

  function isOrderSnapshotSent(orderId, snapshotKey) {
    return !!orderId && !!snapshotKey && sentOrderSnapshots.get(orderId) === snapshotKey;
  }

  function isOrderSnapshotPending(orderId, snapshotKey) {
    return !!orderId && !!snapshotKey && pendingOrderSnapshots.get(orderId) === snapshotKey;
  }

  function clearPendingOrderSnapshot(orderId, snapshotKey) {
    if (!orderId) return;
    if (snapshotKey && pendingOrderSnapshots.get(orderId) !== snapshotKey) return;
    pendingOrderSnapshots.delete(orderId);
  }

  function compareQueuedFills(a, b) {
    if (a.fillData.timestamp !== b.fillData.timestamp) {
      return a.fillData.timestamp.localeCompare(b.fillData.timestamp);
    }
    return a.fillData.fill_id - b.fillData.fill_id;
  }

  async function ensurePreArmReadyForFillSend() {
    const active = getCurrentActivePreArm();
    if (!active || !hasDirtyPreArmDraft(active)) {
      return;
    }
    await flushPreArmDraft();
  }

  async function sendEventPayload(payload) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), EVENT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('timeout');
      throw error;
    } finally {
      clearTimeout(timerId);
    }
  }

  function enqueueEventSend(item) {
    eventSendQueue.push(item);
    eventSendQueue.sort(compareQueuedFills);
    void drainEventSendQueue();
  }

  async function drainEventSendQueue() {
    if (isSendingEvent) return;
    isSendingEvent = true;

    try {
      while (eventSendQueue.length > 0) {
        const item = eventSendQueue[0];
        if (!item || !item.fillData) {
          eventSendQueue.shift();
          continue;
        }

        try {
          await ensurePreArmReadyForFillSend();
          const res = await sendEventPayload(item.fillData);
          if (res.status >= 200 && res.status < 300) {
            eventSendQueue.shift();
            if (item.orderId) {
              clearPendingOrderSnapshot(item.orderId, item.snapshotKey);
              rememberSentOrderSnapshot(item.orderId, item.snapshotKey);
            }
            console.log('[TD] ✅ Fill event sent to backend:', item.fillData.fill_id);
            showFillFeedback(item.fillData);
            refreshStatus();
            if (item.onSuccess) item.onSuccess();
            continue;
          }

          eventSendQueue.shift();
          if (item.onFailure) {
            item.onFailure(res);
          } else {
            throw new Error(`HTTP ${res.status}`);
          }
        } catch (error) {
          if (hasDirtyPreArmDraft(getCurrentActivePreArm())) {
            console.error('[TD] ❌ Fill send blocked until pre-arm draft saves:', error);
            if (item.onBlocked) {
              item.onBlocked(error);
            }
            break;
          }
          eventSendQueue.shift();
          if (item.onFailure) {
            item.onFailure(error);
          } else {
            console.error('[TD] ❌ Failed to send event:', error);
          }
        }
      }
    } finally {
      isSendingEvent = false;
    }
  }

  /**
   * Wait for the Account Manager to appear in the DOM, then call callback.
   */
  function waitForAccountManager(callback) {
    const el = document.querySelector(ACCOUNT_MANAGER_SEL);
    if (el) { callback(el); return; }

    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => waitForAccountManager(callback), { once: true });
      return;
    }

    let done = false;
    const finish = (found) => {
      if (done) return;
      done = true;
      clearAccountManagerWaitObserver();
      if (found) callback(found);
    };

    clearAccountManagerWaitObserver();
    accountManagerWaitObserver = new MutationObserver(() => {
      const found = document.querySelector(ACCOUNT_MANAGER_SEL);
      if (found) finish(found);
    });
    accountManagerWaitObserver.observe(document.body, { childList: true, subtree: true });
    accountManagerWaitTimeoutId = setTimeout(() => {
      console.warn('[TD] Account Manager wait timeout, skip attaching scraper observer');
      finish(null);
    }, ACCOUNT_MANAGER_WAIT_TIMEOUT_MS);
  }

  function runScheduledPoll() {
    if (pollInProgress) {
      pollPending = true;
      return;
    }

    pollInProgress = true;
    lastPollRunAt = Date.now();
    try {
      pollFilledOrders();
      pollOpenPositions();
    } finally {
      pollInProgress = false;
      if (pollPending) {
        pollPending = false;
        schedulePoll();
      }
    }
  }

  function schedulePoll() {
    if (cleanedUp) return;

    if (pollInProgress) {
      pollPending = true;
      return;
    }

    const elapsed = Date.now() - lastPollRunAt;
    if (elapsed >= POLL_MIN_INTERVAL_MS) {
      runScheduledPoll();
      return;
    }

    if (pollDelayTimerId) return;
    pollDelayTimerId = setTimeout(() => {
      pollDelayTimerId = null;
      runScheduledPoll();
    }, POLL_MIN_INTERVAL_MS - elapsed);
  }

  /**
   * Start the DOM scraper: interval polling + MutationObserver for fast detection.
   */
  function startScraper() {
    if (cleanedUp || scraperIntervalId) return;
    console.log('[TD] 🔍 DOM scraper starting — watching Orders > Filled table');

    // Interval-based polling as the primary mechanism
    scraperIntervalId = setInterval(schedulePoll, SCRAPE_INTERVAL_MS);

    // MutationObserver for faster detection when new rows are added
    waitForAccountManager((container) => {
      if (cleanedUp) return;
      if (scraperObserver) scraperObserver.disconnect();
      scraperObserver = new MutationObserver(schedulePoll);
      scraperObserver.observe(container, { childList: true, subtree: true });
      console.log('[TD] 🔍 MutationObserver attached to Account Manager');
    });

    // Immediate first poll
    schedulePoll();
  }

  /**
   * Scan the Filled orders table for new rows and forward any new fills.
   */
  function pollFilledOrders() {
    const table = document.querySelector(FILLED_TABLE_SEL);
    if (!table) return;

    const rows = table.querySelectorAll('tbody tr.ka-row');
    if (!rows.length) return;

    // Full scan every SCRAPE_INTERVAL_MS to catch partial-fill updates (same orderId, new qty).
    // Between full scans, skip already-sent rows to reduce MutationObserver-triggered DOM churn.
    const doFullScan = Date.now() - lastFullScanAt >= SCRAPE_INTERVAL_MS;
    if (doFullScan) lastFullScanAt = Date.now();

    const newRows = [];
    for (const row of rows) {
      const orderId = row.dataset.rowId;
      if (!orderId) continue;

      if (!doFullScan && sentOrderSnapshots.has(orderId) && !pendingOrderSnapshots.has(orderId)) continue;

      const fillData = scrapeOrderRow(row, orderId);
      if (fillData) {
        const snapshotKey = buildOrderSnapshotKey(fillData);
        if (!snapshotKey || isOrderSnapshotSent(orderId, snapshotKey) || isOrderSnapshotPending(orderId, snapshotKey)) {
          continue;
        }
        newRows.push({ orderId, fillData, snapshotKey });
      }
    }

    if (newRows.length === 0) return;

    newRows.sort(compareQueuedFills);
    for (const item of newRows) {
      setPendingOrderSnapshot(item.orderId, item.snapshotKey);
      console.log('[TD] 📌 New filled order detected:', item.fillData);
      forwardToBackend(item.fillData, item.orderId, item.snapshotKey);
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
  function forwardToBackend(fillData, orderId, snapshotKey) {
    enqueueEventSend({
      fillData,
      orderId,
      snapshotKey,
      onFailure: (error) => {
        console.error('[TD] ❌ Backend rejected/unreachable:', error);
        queueForRetry(fillData, orderId, snapshotKey);
      },
    });
  }

  // ============================================================
  // 1b. DOM Scraper — Positions Tab (open position indicator)
  // ============================================================

  function pollOpenPositions() {
    // Use cached selector if we previously discovered the table
    let table = document.querySelector(cachedPositionTableSel || POSITIONS_TABLE_SEL);

    // Fallback: search for any table with "position" in data-name
    if (!table && !cachedPositionTableSel) {
      const accountManager = document.querySelector(ACCOUNT_MANAGER_SEL);
      if (accountManager) {
        const candidates = accountManager.querySelectorAll('table[data-name]');
        for (const t of candidates) {
          if (t.dataset.name.toLowerCase().includes('position')) {
            table = t;
            cachedPositionTableSel = `table[data-name="${t.dataset.name}"]`;
            console.log('[TD] Position table discovered, caching selector:', cachedPositionTableSel);
            break;
          }
        }
        // Discovery logging: show all data-name tables once
        if (!positionTableDiscoveryLogged) {
          positionTableDiscoveryLogged = true;
          const names = Array.from(candidates).map((t) => t.dataset.name);
          console.log('[TD] Position table discovery — available data-name tables:', names);
          if (!table) {
            console.warn('[TD] No position table found. Selector tried:', POSITIONS_TABLE_SEL);
          }
        }
      }
    }

    if (!table) {
      if (currentOpenPosition !== null) {
        currentOpenPosition = null;
        renderPanel(lastStatus, lastTrades);
      }
      return;
    }

    const row = table.querySelector('tbody tr.ka-row');
    if (!row) {
      if (currentOpenPosition !== null) {
        currentOpenPosition = null;
        renderPanel(lastStatus, lastTrades);
      }
      return;
    }

    // Discovery: log all data-label values once
    if (!positionLabelDiscoveryLogged) {
      positionLabelDiscoveryLogged = true;
      const labels = Array.from(row.querySelectorAll('td[data-label]')).map((td) => td.dataset.label);
      console.log('[TD] Position row data-labels:', labels);
    }

    try {
      // Symbol — uses same special wrapper as filled orders
      const symbolEl = row.querySelector('.titleContent-oThzYPsJ');
      const rawSymbol = symbolEl?.textContent?.trim() || '';
      // Strip contract suffix (e.g. "ESH5" → "ES", "MESH5" → "MES")
      const symbol = rawSymbol.replace(/[A-Z]\d+$/, '');

      if (!symbol || !SUPPORTED_SYMBOLS.has(symbol)) {
        if (currentOpenPosition !== null) {
          currentOpenPosition = null;
          renderPanel(lastStatus, lastTrades);
        }
        return;
      }

      // Side
      const sideEl = row.querySelector('[data-label="Side"] .ka-cell-text')
        || row.querySelector('[data-label="B/S"] .ka-cell-text');
      const rawSide = sideEl?.textContent?.trim() || '';
      const sideLower = rawSide.toLowerCase();
      let side;
      if (sideLower === 'buy' || sideLower === 'b' || sideLower === 'long' || sideLower === 'l') {
        side = 'Long';
      } else if (sideLower === 'sell' || sideLower === 's' || sideLower === 'short') {
        side = 'Short';
      } else {
        // Unknown side value; treat as no valid position
        if (currentOpenPosition !== null) {
          currentOpenPosition = null;
          renderPanel(lastStatus, lastTrades);
        }
        return;
      }

      // Qty
      const qtyEl = row.querySelector('[data-label="Qty"] .ka-cell-text')
        || row.querySelector('[data-label="Net Pos"] .ka-cell-text');
      const qty = Math.abs(parseFloat(qtyEl?.textContent?.trim() || '0'));

      // Entry price
      const priceEl = row.querySelector('[data-label="Avg Price"] .ka-cell-text')
        || row.querySelector('[data-label="Entry Price"] .ka-cell-text')
        || row.querySelector('[data-label="Avg Fill Price"] .ka-cell-text');
      const entryPrice = parseFloat((priceEl?.textContent?.trim() || '0').replace(/,/g, ''));

      // Unrealized P&L
      const pnlEl = row.querySelector('[data-label="P&L"] .ka-cell-text')
        || row.querySelector('[data-label="Unrealized P&L"] .ka-cell-text')
        || row.querySelector('[data-label="P/L"] .ka-cell-text');
      const pnlText = pnlEl?.textContent?.trim() || '';
      const parsedPnl = pnlText ? parseFloat(pnlText.replace(/[$,]/g, '')) : null;
      const unrealizedPnl = Number.isFinite(parsedPnl) ? parsedPnl : null;

      if (qty <= 0 || isNaN(entryPrice) || entryPrice <= 0) {
        if (currentOpenPosition !== null) {
          currentOpenPosition = null;
          renderPanel(lastStatus, lastTrades);
        }
        return;
      }

      // Check if position actually changed
      const prev = currentOpenPosition;
      const structuralChanged = !prev
        || prev.symbol !== symbol
        || prev.side !== side
        || prev.qty !== qty
        || prev.entryPrice !== entryPrice;
      const pnlChanged = !prev || prev.unrealizedPnl !== unrealizedPnl;

      if (structuralChanged || pnlChanged) {
        currentOpenPosition = {
          symbol,
          side,
          qty,
          entryPrice,
          unrealizedPnl,
          firstSeenAt: (prev && prev.symbol === symbol && prev.side === side) ? prev.firstSeenAt : new Date().toISOString(),
        };
        if (structuralChanged) {
          renderPanel(lastStatus, lastTrades);
        } else {
          // Only P&L changed — update in place to avoid full panel rebuild
          updatePnlInPlace(unrealizedPnl);
        }
      }
    } catch (e) {
      console.error('[TD] Error scraping position row:', e);
    }
  }

  // ============================================================
  // 2. Retry Queue (degraded fallback)
  // ============================================================

  function loadRetryQueue() {
    try {
      const queue = JSON.parse(localStorage.getItem(RETRY_QUEUE_KEY) || '[]');
      return Array.isArray(queue) ? queue : [];
    } catch {
      return [];
    }
  }

  function saveRetryQueue(queue) {
    localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(queue));
  }

  function generateRetryId() {
    return `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function buildLegacyRetryId(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const ts = Number(safeItem.timestamp) || 0;
    const attempts = Number(safeItem.attempts) || 0;
    const fillId = safeItem.data && safeItem.data.fill_id !== undefined
      ? safeItem.data.fill_id
      : 'na';
    return `legacy_${ts}_${fillId}_${attempts}`;
  }

  function normalizeRetryItem(item) {
    const safeItem = item && typeof item === 'object' ? item : {};
    const snapshotKey = typeof safeItem.snapshot_key === 'string' && safeItem.snapshot_key
      ? safeItem.snapshot_key
      : buildOrderSnapshotKey(safeItem.data);
    return {
      retry_id: typeof safeItem.retry_id === 'string' && safeItem.retry_id
        ? safeItem.retry_id
        : buildLegacyRetryId(safeItem),
      data: safeItem.data,
      order_id: typeof safeItem.order_id === 'string' ? safeItem.order_id : '',
      snapshot_key: snapshotKey,
      attempts: Number(safeItem.attempts) || 0,
      timestamp: Number(safeItem.timestamp) || Date.now(),
    };
  }

  function queueForRetry(fillData, orderId, snapshotKey) {
    try {
      const queue = loadRetryQueue();
      const normalizedSnapshotKey = snapshotKey || buildOrderSnapshotKey(fillData);
      const alreadyQueued = queue.some((item) => {
        const normalized = normalizeRetryItem(item);
        return normalized.order_id === (orderId || '') &&
          normalized.snapshot_key === normalizedSnapshotKey;
      });
      if (alreadyQueued) return;
      queue.push({
        retry_id: generateRetryId(),
        data: fillData,
        order_id: orderId || '',
        snapshot_key: normalizedSnapshotKey,
        attempts: 0,
        timestamp: Date.now(),
      });
      saveRetryQueue(queue);
      console.log(`[TD] Queued for retry (${queue.length} pending)`);
    } catch (e) {
      console.error('[TD] Failed to queue for retry:', e);
    }
  }

  async function processRetryQueue() {
    if (isProcessingRetryQueue) return;
    isProcessingRetryQueue = true;

    try {
      const queueSnapshot = loadRetryQueue().map(normalizeRetryItem);
      if (queueSnapshot.length === 0) return;

      const snapshotIds = new Set(queueSnapshot.map(item => item.retry_id));
      const remainingFromSnapshot = [];

      for (const item of queueSnapshot) {
        if (item.attempts >= MAX_RETRY_ATTEMPTS) {
          console.warn('[TD] Dead letter — max retries exceeded:', item.data);
          if (item.order_id) clearPendingOrderSnapshot(item.order_id, item.snapshot_key);
          continue;
        }
        if (!item.data) {
          console.warn('[TD] Dead letter — invalid retry payload:', item);
          if (item.order_id) clearPendingOrderSnapshot(item.order_id, item.snapshot_key);
          continue;
        }

        const nextItem = { ...item, attempts: item.attempts + 1 };
        try {
          const success = await new Promise((resolve) => {
            enqueueEventSend({
              fillData: item.data,
              orderId: item.order_id || '',
              snapshotKey: item.snapshot_key,
              onSuccess: () => resolve(true),
              onBlocked: () => resolve(false),
              onFailure: () => resolve(false),
            });
          });
          if (success) {
            console.log('[TD] ✅ Retry successful');
            continue;
          }
          remainingFromSnapshot.push(nextItem);
        } catch {
          remainingFromSnapshot.push(nextItem);
        }
      }

      const latestQueue = loadRetryQueue().map(normalizeRetryItem);
      const concurrentItems = latestQueue.filter(item => !snapshotIds.has(item.retry_id));
      saveRetryQueue([...remainingFromSnapshot, ...concurrentItems]);
    } catch (e) {
      console.error('[TD] Retry queue error:', e);
    } finally {
      isProcessingRetryQueue = false;
    }
  }

  // Retry every 60s
  if (!IS_TEST_MODE) {
    retryIntervalId = setInterval(processRetryQueue, 60000);
  }

  // ============================================================
  // 3. Panel UI (M3)
  // ============================================================

  let panelEl = null;
  let lastStatus = null;
  let lastTrades = [];
  let lastUpdateTime = null;
  let isCollapsed = localStorage.getItem('td_panel_collapsed') === 'true';
  let panelPos = JSON.parse(localStorage.getItem('td_panel_pos') || '{"top":"80px","right":"80px","left":""}');
  let panelInteractionsBound = false;
  let playbooksCache = [];
  let playbookLoadPromise = null;
  let pendingTradeIdsInitialized = false;
  let seenPendingTradeIds = new Set();
  let pendingReviewTargetDate = null;
  let pendingReviewTargetFetchedAt = 0;
  let pendingReviewTargetCount = 0;
  let panelView = 'normal'; // 'normal' | 'prearm'
  let preArmSelectionId = '';
  let preArmShortcutBound = false;
  let preArmCreatePending = false;
  let preArmCancelPending = false;
  let preArmChecklistSyncPending = false;
  let preArmDraft = loadPreArmDraftFromStorage();
  let preArmFlushPromise = null;
  let preArmHydrationPromise = null;
  let preArmActiveSnapshot = undefined;
  let preArmSyncError = '';
  let currentOpenPosition = null; // { symbol, side, qty, entryPrice, unrealizedPnl, firstSeenAt }
  let positionTableDiscoveryLogged = false;
  let positionLabelDiscoveryLogged = false;
  let cachedPositionTableSel = null; // cached selector after first successful discovery
  const panelDragState = {
    isDragging: false,
    startX: 0,
    startY: 0,
    initialLeft: 0,
    initialTop: 0,
  };

  function initPanel() {
    // Wait for page to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createPanel, { once: true });
    } else {
      // Small delay to let TradingView UI settle
      panelInitTimeoutId = setTimeout(() => {
        panelInitTimeoutId = null;
        createPanel();
      }, 2000);
    }
  }

  function createPanel() {
    if (cleanedUp || panelEl) return;

    // Inject styles
    const tdStyle = document.createElement('style');
    tdStyle.textContent = `
      #td-panel {
        position: fixed;
        width: 320px;
        padding: 14px 16px 16px;
        background: #131722;
        color: #d1d4dc;
        border: 1px solid #2a2e39;
        border-radius: 14px;
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
        user-select: none;
        box-sizing: border-box;
        contain: layout style;
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
        border-bottom: 1px solid #2a2e39;
      }
      .td-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #td-panel .td-review-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px 6px;
        border-radius: 3px;
        border: 1px solid rgba(255, 179, 0, 0.4);
        background: rgba(255, 179, 0, 0.2);
        color: #ffb300;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.2;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
        white-space: nowrap;
      }
      #td-panel .td-review-badge:hover {
        background: rgba(255, 179, 0, 0.28);
        border-color: rgba(255, 179, 0, 0.5);
        color: #ffd54f;
      }
      .td-collapse-btn {
        cursor: pointer;
        opacity: 0.5;
        transition: opacity 0.15s;
        font-size: 10px;
      }
      .td-collapse-btn:hover {
        opacity: 1;
      }
      #td-panel .td-title {
        font-size: 13px;
        font-weight: 600;
        color: #d1d4dc;
        letter-spacing: 0.02em;
      }
      #td-panel .td-risk-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: inline-block;
        transition: background 0.15s;
      }
      #td-panel .td-risk-green { background: #26a69a; }
      #td-panel .td-risk-red { background: #ef5350; }
      #td-panel .td-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 0;
      }
      #td-panel .td-label {
        color: #787b86;
        font-size: 12px;
      }
      #td-panel .td-value {
        font-weight: 600;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      #td-panel .td-positive { color: #26a69a; }
      #td-panel .td-negative { color: #ef5350; }
      #td-panel .td-orange { color: #ffb300; }
      #td-panel .td-neutral { color: #d1d4dc; }
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
      #td-panel .td-chip-w { background: rgba(38, 166, 154, 0.2); color: #26a69a; }
      #td-panel .td-chip-l { background: rgba(239, 83, 80, 0.2); color: #ef5350; }
      #td-panel .td-chip-be { background: rgba(255, 179, 0, 0.2); color: #ffb300; }
      #td-panel .td-degraded {
        font-size: 10px;
        color: #4a4e5a;
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
      #td-panel .td-dot-empty { color: #4a4e5a; }
      #td-panel .td-dot-gold { color: #ffb300; }
      #td-panel .td-dot-orange { color: #ffb300; }
      #td-panel .td-dot-red { color: #ef5350; }
      /* Overflow alert badge */
      #td-panel .td-overflow-badge {
        display: inline-block;
        background: rgba(239, 83, 80, 0.2);
        color: #ef5350;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border: 1px solid rgba(239, 83, 80, 0.4);
        border-radius: 3px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        opacity: 0.85;
      }
      /* Fill capture flash */
      @keyframes td-fill-flash {
        0%   { border-color: rgba(38, 166, 154, 0.8); box-shadow: 0 0 18px rgba(38, 166, 154, 0.5), 0 16px 48px rgba(0, 0, 0, 0.45); }
        100% { border-color: #2a2e39; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45); }
      }
      @keyframes td-fill-flash-golden {
        0%   { border-color: rgba(38, 166, 154, 0.8); box-shadow: 0 0 18px rgba(38, 166, 154, 0.5), 0 16px 48px rgba(0, 0, 0, 0.45); }
        100% { border-color: rgba(255, 179, 0, 0.3); box-shadow: 0 0 12px rgba(255, 179, 0, 0.35), 0 16px 48px rgba(0, 0, 0, 0.45); }
      }
      #td-panel.td-fill-flash {
        animation: td-fill-flash 0.8s ease-out forwards;
      }
      #td-panel.td-golden-border.td-fill-flash {
        animation: td-fill-flash-golden 0.8s ease-out forwards;
      }

      /* Fill toast notifications */
      #td-fill-toasts {
        position: fixed;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 6px;
        pointer-events: none;
      }
      @keyframes td-toast-in {
        from { opacity: 0; transform: translateY(-8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes td-toast-out {
        from { opacity: 1; transform: translateY(0); }
        to   { opacity: 0; transform: translateY(-8px); }
      }
      .td-fill-toast {
        background: #1a1e2d;
        border: 1px solid rgba(38, 166, 154, 0.3);
        border-radius: 4px;
        padding: 6px 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        font-size: 12px;
        color: #d1d4dc;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        animation: td-toast-in 0.25s ease-out;
        white-space: nowrap;
      }
      .td-fill-toast.td-toast-removing {
        animation: td-toast-out 0.3s ease-in forwards;
      }
      .td-fill-toast .td-toast-buy { color: #26a69a; font-weight: 600; }
      .td-fill-toast .td-toast-sell { color: #ef5350; font-weight: 600; }

      #td-panel .td-dots-label {
        font-size: 11px;
        color: #787b86;
      }

      /* Golden zone border */
      #td-panel.td-golden-border {
        box-shadow: 0 0 12px rgba(255, 179, 0, 0.35), 0 16px 48px rgba(0, 0, 0, 0.45);
        border-color: rgba(255, 179, 0, 0.3);
      }
      /* Golden complete banner */
      #td-panel .td-golden-msg {
        background: rgba(255, 179, 0, 0.1);
        border: 1px solid rgba(255, 179, 0, 0.25);
        border-radius: 4px;
        padding: 6px 10px;
        font-size: 12px;
        color: #ffb300;
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
        background: #1e222d;
        border-radius: 8px;
        padding: 24px 28px;
        max-width: 420px;
        width: 90%;
        color: #d1d4dc;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      }
      #td-limit-modal.td-limit-overtime {
        border: 1px solid rgba(255, 179, 0, 0.3);
        box-shadow: 0 8px 40px rgba(255, 179, 0, 0.2);
      }
      #td-limit-modal.td-limit-red {
        border: 1px solid rgba(239, 83, 80, 0.3);
        box-shadow: 0 8px 40px rgba(239, 83, 80, 0.2);
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
      #td-limit-modal.td-limit-overtime .td-modal-title { color: #ffb300; }
      #td-limit-modal.td-limit-red .td-modal-title { color: #ef5350; }
      #td-limit-modal .td-modal-body {
        font-size: 13px;
        line-height: 1.7;
        color: #787b86;
        margin-bottom: 20px;
      }
      #td-limit-modal .td-limit-reason {
        width: 100%;
        background: #131722;
        border: 1px solid #2a2e39;
        border-radius: 4px;
        padding: 8px 10px;
        color: #d1d4dc;
        font-size: 13px;
        font-family: inherit;
        resize: vertical;
        min-height: 60px;
        margin-bottom: 16px;
        box-sizing: border-box;
      }
      #td-limit-modal .td-limit-reason::placeholder { color: #4a4e5a; }
      #td-limit-modal .td-limit-reason:focus { outline: none; border-color: #2962ff; }
      #td-limit-modal .td-modal-btns {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }
      #td-limit-modal .td-btn {
        padding: 8px 20px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: opacity 0.15s;
      }
      #td-limit-modal .td-btn:hover { opacity: 0.85; }
      #td-limit-modal .td-btn-cancel {
        background: #252a38;
        border: 1px solid #2a2e39;
        color: #d1d4dc;
      }
      #td-limit-modal .td-btn-confirm {
        color: #fff;
      }
      #td-limit-modal.td-limit-overtime .td-btn-confirm { background: #ffb300; color: #131722; }
      #td-limit-modal.td-limit-red .td-btn-confirm { background: #ef5350; }
      #td-limit-modal .td-btn-confirm:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      #td-panel .td-divider {
        height: 1px;
        background: #2a2e39;
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
        background: #252a38;
        border: 1px solid #2a2e39;
        border-radius: 4px;
        color: #787b86;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        font-family: inherit;
      }
      #td-panel .td-anno-btn:hover {
        background: #2e3348;
        border-color: #3d4560;
        color: #d1d4dc;
      }
      #td-panel .td-anno-badge {
        background: rgba(255, 179, 0, 0.2);
        color: #ffb300;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 3px;
        border: 1px solid rgba(255, 179, 0, 0.4);
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
        background: #1e222d;
        border: 1px solid #2a2e39;
        border-radius: 8px;
        padding: 20px 24px;
        max-width: 480px;
        width: 92%;
        color: #d1d4dc;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
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
        border-bottom: 1px solid #2a2e39;
      }
      .td-anno-modal-title {
        font-size: 15px;
        font-weight: 700;
      }
      .td-anno-close {
        cursor: pointer;
        font-size: 18px;
        color: #787b86;
        background: none;
        border: none;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.15s;
      }
      .td-anno-close:hover { color: #d1d4dc; }

      /* Trade navigator */
      .td-anno-nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        margin-bottom: 14px;
        background: #131722;
        border-radius: 4px;
        gap: 8px;
      }
      .td-anno-nav-arrow {
        cursor: pointer;
        font-size: 16px;
        color: #787b86;
        background: none;
        border: none;
        padding: 2px 8px;
        border-radius: 4px;
        transition: background 0.15s, color 0.15s;
      }
      .td-anno-nav-arrow:hover:not(:disabled) {
        background: #252a38;
        color: #d1d4dc;
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
        color: #787b86;
        margin-bottom: 2px;
      }
      .td-anno-nav-trade {
        font-size: 13px;
        font-weight: 600;
      }
      .td-anno-nav-check {
        color: #26a69a;
        margin-left: 6px;
      }

      /* Field rows */
      .td-anno-field {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 6px 0;
        gap: 10px;
      }
      .td-anno-field-label {
        font-size: 12px;
        color: #787b86;
        white-space: nowrap;
        min-width: 70px;
        padding-top: 8px;
      }
      .td-anno-field-label-missing {
        color: #ef5350;
      }
      .td-anno-required {
        color: #ef5350;
        margin-left: 2px;
      }
      .td-anno-field-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-width: 240px;
      }
      .td-anno-select {
        flex: 1;
        background: #131722;
        border: 1px solid #2a2e39;
        border-radius: 4px;
        padding: 6px 10px;
        color: #d1d4dc;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        appearance: auto;
        max-width: none;
      }
      .td-anno-select:focus {
        outline: none;
        border-color: #2962ff;
      }
      .td-anno-input-missing {
        border-color: rgba(239, 83, 80, 0.55) !important;
        box-shadow: 0 0 0 1px rgba(239, 83, 80, 0.18);
      }
      .td-anno-field-hint {
        font-size: 11px;
        color: #ef5350;
        line-height: 1.35;
      }

      /* Multi-select trigger dropdown */
      .td-anno-multiselect {
        position: relative;
        flex: 1;
        max-width: 240px;
      }
      .td-anno-multiselect-display {
        background: #131722;
        border: 1px solid #2a2e39;
        border-radius: 4px;
        padding: 4px 10px;
        min-height: 32px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        font-size: 13px;
        color: #787b86;
      }
      .td-anno-multiselect-display:hover {
        border-color: #2962ff;
      }
      .td-anno-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: rgba(255, 179, 0, 0.2);
        color: #ffb300;
        border-radius: 3px;
        padding: 1px 6px;
        font-size: 10px;
        font-weight: 600;
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
        background: #1e222d;
        border: 1px solid #2a2e39;
        border-radius: 4px;
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
        color: #787b86;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .td-anno-multiselect-option:hover {
        background: #252a38;
      }
      .td-anno-multiselect-option.selected {
        color: #ffb300;
      }
      .td-anno-multiselect-check {
        width: 14px;
        text-align: center;
        font-size: 11px;
      }

      /* Discipline checks section */
      .td-anno-checks-title {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: #787b86;
        margin: 12px 0 8px;
        padding-top: 10px;
        border-top: 1px solid #2a2e39;
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
        color: #787b86;
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
        border: 1px solid #2a2e39;
        background: #252a38;
        color: #787b86;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      .td-anno-btn-group-missing button {
        border-color: rgba(239, 83, 80, 0.55);
      }
      .td-anno-btn-group button:hover {
        background: #2e3348;
        color: #d1d4dc;
      }
      .td-anno-btn-active-yes {
        background: rgba(38, 166, 154, 0.2) !important;
        border-color: rgba(38, 166, 154, 0.4) !important;
        color: #26a69a !important;
      }
      .td-anno-btn-active-partial {
        background: rgba(255, 179, 0, 0.2) !important;
        border-color: rgba(255, 179, 0, 0.4) !important;
        color: #ffb300 !important;
      }
      .td-anno-btn-active-no {
        background: rgba(239, 83, 80, 0.2) !important;
        border-color: rgba(239, 83, 80, 0.4) !important;
        color: #ef5350 !important;
      }

      /* Score display */
      .td-anno-score {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 0;
        margin-top: 8px;
        border-top: 1px solid #2a2e39;
      }
      .td-anno-score-label {
        font-size: 13px;
        font-weight: 600;
        color: #787b86;
      }
      .td-anno-score-value {
        font-size: 18px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .td-anno-error-hint {
        font-size: 11px;
        color: #ffb300;
        font-style: italic;
      }

      /* Save button */
      .td-anno-save-btn {
        width: 100%;
        padding: 10px 0;
        margin-top: 12px;
        background: #2962ff;
        border: none;
        border-radius: 4px;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
        font-family: inherit;
      }
      .td-anno-save-btn:hover { background: #1e50d8; }
      .td-anno-save-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .td-anno-save-hint {
        margin-top: 10px;
        font-size: 12px;
        color: #ef5350;
        line-height: 1.4;
      }

      /* Panel layout overrides */
      #td-panel .td-row {
        gap: 12px;
        padding: 4px 0;
      }
      #td-panel .td-label {
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      #td-panel .td-divider {
        margin: 12px 0;
      }
      #td-panel .td-zone-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin: 6px 0 2px;
      }
      #td-panel .td-setup-btn {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        padding: 9px 11px;
        margin-top: 8px;
        background: rgba(41, 98, 255, 0.08);
        border: 1px solid rgba(41, 98, 255, 0.2);
        border-radius: 4px;
        color: #d1d4dc;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
        font-family: inherit;
      }
      #td-panel .td-setup-btn:hover {
        background: rgba(41, 98, 255, 0.14);
        border-color: rgba(41, 98, 255, 0.32);
      }
      #td-panel .td-setup-btn.td-setup-active {
        border-color: rgba(38, 166, 154, 0.26);
        background: rgba(38, 166, 154, 0.1);
      }
      #td-panel .td-setup-btn-main {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #td-panel .td-setup-btn-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 4px;
        background: #252a38;
        font-size: 13px;
      }
      #td-panel .td-setup-btn-copy {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        line-height: 1.2;
      }
      #td-panel .td-setup-btn-sub,
      #td-panel .td-setup-btn-hotkey {
        font-size: 11px;
        color: #787b86;
      }
      #td-panel .td-setup-btn-hotkey {
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      #td-panel .td-trade-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #td-panel .td-trade-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #2a2e39;
        border-radius: 4px;
        background: #1e222d;
        color: #d1d4dc;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
        box-sizing: border-box;
        font-family: inherit;
      }
      #td-panel .td-trade-row:hover {
        background: #252a38;
        border-color: #3d4560;
      }
      #td-panel .td-trade-row.td-trade-pending {
        border-color: rgba(255, 179, 0, 0.26);
      }
      #td-panel .td-trade-main {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
      }
      #td-panel .td-trade-time {
        font-size: 12px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #td-panel .td-trade-symbol {
        font-size: 12px;
        color: #787b86;
        letter-spacing: 0.06em;
      }
      #td-panel .td-trade-metrics {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-left: auto;
      }
      #td-panel .td-trade-result-badge,
      #td-panel .td-setup-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 600;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      #td-panel .td-trade-result-badge {
        min-width: 24px;
        padding: 1px 6px;
        background: #252a38;
      }
      #td-panel .td-trade-pnl {
        font-size: 12px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      #td-panel .td-result-w { color: #26a69a; }
      #td-panel .td-result-l { color: #ef5350; }
      #td-panel .td-result-be { color: #ffb300; }
      #td-panel .td-result-na { color: #787b86; }
      #td-panel .td-neutral { color: #787b86; }
      #td-panel .td-setup-pill {
        min-width: 46px;
        padding: 2px 8px;
      }
      #td-panel .td-setup-complete {
        background: rgba(38, 166, 154, 0.2);
        color: #26a69a;
        border: 1px solid rgba(38, 166, 154, 0.4);
      }
      #td-panel .td-setup-partial {
        background: rgba(255, 179, 0, 0.2);
        color: #ffb300;
        border: 1px solid rgba(255, 179, 0, 0.4);
      }
      #td-panel .td-setup-none {
        background: #252a38;
        color: #787b86;
      }
      #td-panel .td-empty-state {
        padding: 12px 10px;
        border-radius: 4px;
        background: #1e222d;
        color: #787b86;
        text-align: center;
        font-size: 12px;
      }
      /* Open position indicator */
      #td-panel .td-open-position {
        background: rgba(66, 165, 245, 0.08);
        border: 1px solid rgba(66, 165, 245, 0.25);
        border-radius: 4px;
        padding: 10px 12px;
      }
      #td-panel .td-open-position-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      #td-panel .td-open-position-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(66, 165, 245, 0.8);
      }
      #td-panel .td-side-long { color: #26a69a; font-weight: 700; font-size: 13px; }
      #td-panel .td-side-short { color: #ef5350; font-weight: 700; font-size: 13px; }
      #td-panel .td-open-position-detail {
        display: flex;
        align-items: baseline;
        gap: 6px;
        font-size: 13px;
        color: #d1d4dc;
      }
      #td-panel .td-open-position-detail .td-trade-symbol {
        font-weight: 700;
        color: #d1d4dc;
      }
      #td-panel .td-open-position-pnl {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        margin-top: 4px;
      }
      #td-panel .td-footer-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #td-panel .td-stat {
        padding: 10px 11px;
        border-radius: 4px;
        background: #1e222d;
        border: 1px solid #2a2e39;
        color: inherit;
        text-align: left;
        font-family: inherit;
      }
      #td-panel .td-stat-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #787b86;
        margin-bottom: 2px;
      }
      #td-panel .td-stat-value {
        font-size: 15px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #td-panel .td-stat-link {
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      #td-panel .td-stat-link:hover:not(:disabled) {
        border-color: #3d4560;
        background: #252a38;
      }
      #td-panel .td-stat-link:disabled {
        cursor: default;
        opacity: 0.7;
      }
      /* Pre-arm panel view styles */
      #td-panel .td-prearm-section {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      #td-panel .td-prearm-controls {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
      }
      #td-panel .td-prearm-select,
      .td-anno-select,
      .td-anno-note {
        width: 100%;
        box-sizing: border-box;
        background: #131722;
        border: 1px solid #2a2e39;
        border-radius: 4px;
        padding: 9px 10px;
        color: #d1d4dc;
        font-size: 13px;
        font-family: inherit;
      }
      #td-panel .td-prearm-select:focus,
      .td-anno-select:focus,
      .td-anno-note:focus {
        outline: none;
        border-color: #2962ff;
      }
      #td-panel .td-prearm-btn {
        border: none;
        border-radius: 4px;
        padding: 10px 14px;
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        background: #2962ff;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s;
      }
      #td-panel .td-prearm-btn:hover { background: #1e50d8; }
      #td-panel .td-prearm-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      #td-panel .td-prearm-btn-secondary {
        background: #252a38;
        color: #d1d4dc;
        border: 1px solid #2a2e39;
      }
      #td-panel .td-prearm-chip-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 12px;
      }
      #td-panel .td-prearm-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 1px 6px;
        border-radius: 3px;
        background: rgba(38, 166, 154, 0.2);
        color: #26a69a;
        border: 1px solid rgba(38, 166, 154, 0.4);
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      #td-panel .td-prearm-helper {
        font-size: 12px;
        color: #787b86;
        line-height: 1.5;
      }
      #td-panel .td-prearm-status {
        font-size: 12px;
        color: #787b86;
        line-height: 1.5;
        min-height: 18px;
      }
      #td-panel .td-prearm-status-error {
        color: #ffb300;
      }
      #td-panel .td-prearm-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #td-panel .td-prearm-actions {
        display: flex;
        justify-content: flex-end;
      }
      #td-panel .td-prearm-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 9px 10px;
        border-radius: 4px;
        background: #1e222d;
        border: 1px solid #2a2e39;
        cursor: pointer;
      }
      #td-panel .td-prearm-item input {
        margin-top: 3px;
      }
      #td-panel .td-prearm-item span {
        font-size: 12px;
        line-height: 1.5;
      }
      #td-panel .td-prearm-pnl {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #td-panel .td-prearm-zone-icon {
        font-size: 14px;
      }
      #td-panel .td-prearm-zone-icon.td-zone-golden { color: #ffb300; }
      #td-panel .td-prearm-zone-icon.td-zone-overtime { color: #ffb300; }
      /* Back button in pre-arm header */
      #td-panel .td-prearm-back {
        background: none; border: none; color: #787b86;
        cursor: pointer; font-size: 16px; line-height: 1; padding: 0;
      }
      #td-panel .td-prearm-back:hover { color: #d1d4dc; }
      /* Pre-arm view always shows content (ignore collapsed class) */
      #td-panel.td-collapsed .td-content.td-prearm-content { display: flex !important; }
      .td-anno-summary {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 12px;
      }
      .td-anno-field {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
      }
      .td-anno-summary-card {
        border-radius: 4px;
        padding: 10px;
        background: #131722;
        border: 1px solid #2a2e39;
      }
      .td-anno-summary-label {
        font-size: 10px;
        color: #787b86;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 3px;
      }
      .td-anno-summary-value {
        font-size: 13px;
        font-weight: 600;
        color: #d1d4dc;
      }
      .td-anno-note {
        min-height: 40px;
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
        background: #1e222d;
        border: 1px solid rgba(239, 83, 80, 0.3);
        border-radius: 8px;
        padding: 24px 28px;
        max-width: 420px;
        width: 90%;
        box-shadow: 0 8px 40px rgba(239, 83, 80, 0.2);
        color: #d1d4dc;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      }
      #td-risk-modal .td-modal-icon {
        font-size: 32px;
        text-align: center;
        margin-bottom: 12px;
      }
      #td-risk-modal .td-modal-title {
        font-size: 16px;
        font-weight: 700;
        color: #ef5350;
        text-align: center;
        margin-bottom: 12px;
      }
      #td-risk-modal .td-modal-body {
        font-size: 13px;
        line-height: 1.7;
        color: #787b86;
        margin-bottom: 20px;
      }
      #td-risk-modal .td-modal-extra {
        background: rgba(255, 179, 0, 0.1);
        border-left: 3px solid #ffb300;
        padding: 8px 12px;
        margin-bottom: 16px;
        font-size: 12px;
        color: #ffb300;
        border-radius: 0 4px 4px 0;
      }
      #td-risk-modal .td-modal-btns {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }
      #td-risk-modal .td-btn {
        padding: 8px 20px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: opacity 0.15s;
      }
      #td-risk-modal .td-btn:hover { opacity: 0.85; }
      #td-risk-modal .td-btn-cancel {
        background: #252a38;
        border: 1px solid #2a2e39;
        color: #d1d4dc;
      }
      #td-risk-modal .td-btn-confirm {
        background: #ef5350;
        color: #fff;
      }
      #td-risk-modal .td-btn-confirm:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    `;
    document.head.appendChild(tdStyle);

    // Create panel element
    panelEl = document.createElement('div');
    panelEl.id = 'td-panel';
    if (isCollapsed) panelEl.classList.add('td-collapsed');

    panelEl.style.top = panelPos.top;
    if (panelPos.left) panelEl.style.left = panelPos.left;
    if (panelPos.right) panelEl.style.right = panelPos.right;

    panelEl.innerHTML = buildPanelHTML(null);
    document.body.appendChild(panelEl);

    const toastContainer = document.createElement('div');
    toastContainer.id = 'td-fill-toasts';
    document.body.appendChild(toastContainer);

    bindPanelInteractionsOnce();

    // Initial fetch
    refreshStatus();

    // Set up polling
    statusIntervalId = setInterval(refreshStatus, REFRESH_INTERVAL);

    console.log('[TD] 📊 Discipline panel initialized');
  }

  let rerenderScheduled = false;
  function rerenderPanel() {
    if (!lastStatus) return;
    if (rerenderScheduled) return;
    rerenderScheduled = true;
    queueMicrotask(() => {
      rerenderScheduled = false;
      if (!lastStatus) return;
      renderPanel(lastStatus, lastTrades);
    });
  }

  function buildPanelHTML(status, trades = lastTrades) {
    if (panelView === 'prearm') {
      return buildPreArmPanelHTML(status);
    }

    if (!status) {
      return `
        <div class="td-header">
          <span class="td-title">DontBlow</span>
          <span class="td-risk-dot td-risk-green"></span>
        </div>
        <div class="td-degraded">Loading...</div>
      `;
    }

    const pnlClass = status.daily_net_pnl >= 0 ? 'td-positive' : 'td-negative';
    const riskClass = status.risk.state === 'red' ? 'td-risk-red' : 'td-risk-green';
    const tl = status.trade_limit || { trades_today: 0, zone: 'waiting', golden_complete: false };
    const dotsHTML = buildTradeDotsHTML(tl);
    const setupAverage = calculateSetupAverage(trades);
    const reviewBadgeHTML = buildPendingReviewBadgeHTML(status);

    return `
      <div class="td-header">
        <span class="td-title">DontBlow</span>
        <div class="td-header-actions">
          ${reviewBadgeHTML}
          <span class="td-risk-dot ${riskClass}" title="Risk: ${status.risk.state}"></span>
          <span class="td-collapse-btn" title="Toggle Panel">${isCollapsed ? '➕' : '➖'}</span>
        </div>
      </div>
      <div class="td-content">
      <div class="td-row">
        <span class="td-label">Today PnL</span>
        <span class="td-value ${pnlClass}">${formatMoney(status.daily_net_pnl, 2)}</span>
      </div>
      ${dotsHTML}
      ${tl.golden_complete ? '<div class="td-golden-msg">Perfect day — Consider wrapping up?</div>' : ''}
      <div class="td-divider"></div>
      ${buildPreArmButtonHTML(status)}
      <div class="td-divider"></div>
      ${buildOpenPositionHTML()}
      ${buildTradeListHTML(trades)}
      <div class="td-divider"></div>
      <div class="td-footer-grid">
        <div class="td-stat">
          <div class="td-stat-label">Setup Avg</div>
          <div class="td-stat-value">${setupAverage === null ? '—' : `${Math.round(setupAverage * 100)}%`}</div>
        </div>
        <button class="td-stat td-stat-link" id="td-pending-open" ${status.pending_annotations > 0 ? '' : 'disabled'}>
          <div class="td-stat-label">Pending</div>
          <div class="td-stat-value">${status.pending_annotations || 0}</div>
        </button>
      </div>
      </div>
    `;
  }

  function buildTradeDotsHTML(tl) {
    const maxDots = 4;
    const count = tl.trades_today;
    const zone = tl.zone;

    // Overflow: replace stars with alert badge
    if (count > maxDots) {
      return `
        <div class="td-zone-row">
          <span class="td-overflow-badge">⚠ ${count} trades</span>
          <span class="td-dots-label">Red zone</span>
        </div>
      `;
    }

    // Normal: star rendering
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

    let label = 'Waiting';
    if (zone === 'golden') label = 'Golden zone';
    else if (zone === 'overtime') label = 'Overtime';
    else if (zone === 'red') label = 'Red zone';

    return `
      <div class="td-zone-row">
        <div class="td-dots">${dots}</div>
        <span class="td-dots-label">${label}</span>
      </div>
    `;
  }

  function buildPreArmPanelHTML(status) {
    const pnlClass = status && status.daily_net_pnl > 0
      ? 'td-positive'
      : status && status.daily_net_pnl < 0
        ? 'td-negative'
        : '';
    const zone = status && status.trade_limit ? status.trade_limit.zone : 'waiting';
    const zoneIcon = zone === 'golden' ? '★' : zone === 'overtime' ? '•' : zone === 'red' ? '🛑' : '';
    const zoneIconClass = zone === 'golden' ? 'td-zone-golden' : zone === 'overtime' ? 'td-zone-overtime' : '';
    const riskClass = status && status.risk && status.risk.state === 'red' ? 'td-risk-red' : 'td-risk-green';
    const riskState = status && status.risk ? status.risk.state : 'green';

    return `
      <div class="td-header">
        <div class="td-header-actions">
          <button class="td-prearm-back" id="td-prearm-back">←</button>
        </div>
        <div class="td-header-actions">
          <span class="td-prearm-pnl ${pnlClass}">${status ? formatMoney(status.daily_net_pnl, 2) : '—'}</span>
          <span class="td-prearm-zone-icon ${zoneIconClass}">${zoneIcon}</span>
          <span class="td-risk-dot ${riskClass}" title="Risk: ${riskState}"></span>
        </div>
      </div>
      <div class="td-content td-prearm-content">
        ${buildPreArmContentHTML()}
      </div>
    `;
  }

  function buildPreArmContentHTML() {
    const active = getCurrentActivePreArm();
    const displayed = getDisplayedPreArm(active);
    const playbookId = active ? active.playbook_id : preArmSelectionId;
    const playbook = findPlaybookDefinition(playbookId);
    const checklistItems = active
      ? active.checklist_items
      : (playbook ? playbook.checklist_items : []);
    const checklistState = displayed
      ? displayed.checklist_state
      : checklistItems.map(() => false);
    const progress = displayed ? `${checklistState.filter(Boolean).length}/${checklistState.length}` : 'preview';
    const options = buildPlaybookOptions(false).map((id) => `
      <option value="${escapeHtml(id)}" ${id === playbookId ? 'selected' : ''}>${escapeHtml(getPlaybookLabel(id))}</option>
    `).join('');
    const statusDescriptor = getPreArmStatusDescriptor(active);

    return `
      <div class="td-prearm-section">
        <div class="td-prearm-controls">
          <select class="td-prearm-select" id="td-prearm-select" ${active ? 'disabled' : ''}>
            ${options}
          </select>
          ${active ? '' : `<button class="td-prearm-btn" id="td-prearm-start" ${isPreArmShellBusy() || preArmHydrationPromise || !preArmSelectionId ? 'disabled' : ''}>${preArmCreatePending ? 'Saving...' : 'Start'}</button>`}
        </div>
        <div class="td-prearm-chip-row">
          <span class="td-prearm-chip" id="td-prearm-chip">${displayed ? `${escapeHtml(displayed.playbook_name)} · ${progress}` : 'Preview'}</span>
        </div>
        <div id="td-prearm-status" class="${statusDescriptor.className}">${escapeHtml(statusDescriptor.text)}</div>
        <div class="td-prearm-list">
          ${checklistItems.map((item, index) => `
            <label class="td-prearm-item">
              <input type="checkbox" data-check-index="${index}" ${checklistState[index] ? 'checked' : ''} ${active && !isPreArmShellBusy() ? '' : 'disabled'}>
              <span>${escapeHtml(item)}</span>
            </label>
          `).join('')}
        </div>
        ${active ? `<div class="td-prearm-actions">
          <button class="td-prearm-btn td-prearm-btn-secondary" id="td-prearm-cancel" ${isPreArmShellBusy() ? 'disabled' : ''}>Cancel watch</button>
        </div>` : ''}
      </div>
    `;
  }

  function bindPreArmPanelEvents() {
    const select = panelEl.querySelector('#td-prearm-select');
    if (select) {
      select.addEventListener('change', (event) => {
        preArmSelectionId = event.target.value;
        rerenderPanel();
      });
    }

    const startBtn = panelEl.querySelector('#td-prearm-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        void startPreArmTracking();
      });
    }

    const cancelBtn = panelEl.querySelector('#td-prearm-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        void cancelActivePreArm();
      });
    }

    panelEl.querySelectorAll('[data-check-index]').forEach((input) => {
      input.addEventListener('change', () => {
        updatePreArmChecklist(Number(input.dataset.checkIndex));
      });
    });
  }

  function buildPreArmButtonHTML(status) {
    const active = getDisplayedPreArm(status && status.active_pre_arm ? status.active_pre_arm : null);
    const checkedCount = active ? active.checklist_state.filter(Boolean).length : 0;
    const totalCount = active ? active.checklist_state.length : 0;
    const buttonClass = active ? 'td-setup-btn td-setup-active' : 'td-setup-btn';
    const label = active ? active.playbook_name : 'Watch setup';

    return `
      <button class="${buttonClass}" id="td-setup-open">
        <span class="td-setup-btn-main">
          <span class="td-setup-btn-icon">🎯</span>
          <span class="td-setup-btn-copy">
            <span class="td-setup-btn-label">${escapeHtml(label)}</span>
          </span>
        </span>
        <span class="td-setup-btn-hotkey">${getPreArmShortcutLabel()}</span>
      </button>
    `;
  }

  function buildOpenPositionHTML() {
    if (!currentOpenPosition) return '';
    const pos = currentOpenPosition;
    const sideClass = pos.side === 'Long' ? 'td-side-long' : 'td-side-short';
    const priceFormatted = pos.entryPrice.toLocaleString('en-US', { minimumFractionDigits: 2 });
    const timeFormatted = formatClockTime(pos.firstSeenAt);
    const pnlLine = pos.unrealizedPnl !== null
      ? `<div class="td-open-position-pnl ${pos.unrealizedPnl >= 0 ? 'td-positive' : 'td-negative'}">${formatMoney(pos.unrealizedPnl, 2)}</div>`
      : '';

    return `
      <div class="td-open-position">
        <div class="td-open-position-header">
          <span class="td-open-position-label">OPEN</span>
          <span class="${sideClass}">${escapeHtml(pos.side)}</span>
        </div>
        <div class="td-open-position-detail">
          <span class="td-trade-symbol">${escapeHtml(pos.symbol)}</span>
          <span>${escapeHtml(String(pos.qty))} @ ${escapeHtml(priceFormatted)}</span>
          <span style="margin-left:auto;color:#787b86;font-size:12px">${timeFormatted}</span>
        </div>
        ${pnlLine}
      </div>
      <div class="td-divider"></div>
    `;
  }

  function buildTradeListHTML(trades) {
    const displayTrades = sortTradesForDisplay(trades).slice(0, 4);
    if (displayTrades.length === 0) {
      return '<div class="td-empty-state">No closed trades yet today.</div>';
    }

    return `
      <div class="td-trade-list">
        ${displayTrades.map((trade) => {
          const result = getTradeResult(trade);
          const resultClass = result === 'W'
            ? 'td-result-w'
            : result === 'L'
              ? 'td-result-l'
              : result === 'BE'
                ? 'td-result-be'
                : 'td-result-na';
          const setupDisplay = getSetupDisplay(trade);
          const pnl = getNumericPnl(trade.realized_pnl_net);
          const pnlClass = pnl === null ? 'td-neutral' : pnl >= 0 ? 'td-positive' : 'td-negative';
          const pendingClass = isAnnotationIncomplete(trade) ? 'td-trade-pending' : '';

          return `
            <button class="td-trade-row ${pendingClass}" data-trade-id="${escapeHtml(trade.trade_id)}">
              <span class="td-trade-main">
                <span class="td-trade-time">${formatClockTime(trade.open_time)}</span>
                <span class="td-trade-symbol">${escapeHtml(trade.symbol)}</span>
              </span>
              <span class="td-trade-metrics">
                <span class="td-trade-result-badge ${resultClass}">${result}</span>
                <span class="td-trade-pnl ${pnlClass}">${formatMoney(pnl, 0)}</span>
                <span class="td-setup-pill ${setupDisplay.className}">${escapeHtml(setupDisplay.text)}</span>
              </span>
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  function onPanelClick(e) {
    if (!panelEl) return;

    const backBtn = e.target.closest('#td-prearm-back');
    if (backBtn && panelEl.contains(backBtn)) {
      e.preventDefault();
      void dismissPreArmView();
      return;
    }

    const toggleBtn = e.target.closest('.td-collapse-btn');
    if (toggleBtn && panelEl.contains(toggleBtn)) {
      e.stopPropagation();
      isCollapsed = !isCollapsed;
      localStorage.setItem('td_panel_collapsed', isCollapsed);
      if (isCollapsed) {
        panelEl.classList.add('td-collapsed');
        toggleBtn.textContent = '➕';
      } else {
        panelEl.classList.remove('td-collapsed');
        toggleBtn.textContent = '➖';
      }
      return;
    }

    const setupBtn = e.target.closest('#td-setup-open');
    if (setupBtn && panelEl.contains(setupBtn)) {
      e.preventDefault();
      void togglePreArmView();
      return;
    }

    const pendingBtn = e.target.closest('#td-pending-open');
    if (pendingBtn && panelEl.contains(pendingBtn)) {
      e.preventDefault();
      void openAnnotationModal();
      return;
    }

    const reviewBtn = e.target.closest('#td-review-open');
    if (reviewBtn && panelEl.contains(reviewBtn)) {
      e.preventDefault();
      openReviewPage(pendingReviewTargetDate);
      return;
    }

    const tradeRow = e.target.closest('[data-trade-id]');
    if (tradeRow && panelEl.contains(tradeRow)) {
      e.preventDefault();
      void openAnnotationModal({ tradeId: tradeRow.dataset.tradeId });
    }
  }

  function onPanelMouseDown(e) {
    if (!panelEl || e.button !== 0) return;
    const header = e.target.closest('.td-header');
    if (!header || !panelEl.contains(header)) return;
    if (e.target.closest('.td-header-actions')) return;

    panelDragState.isDragging = true;
    panelDragState.startX = e.clientX;
    panelDragState.startY = e.clientY;

    const rect = panelEl.getBoundingClientRect();
    panelDragState.initialLeft = rect.left;
    panelDragState.initialTop = rect.top;

    // Clear right positioning to favor left based absolute positioning during drag
    panelEl.style.right = 'auto';
    e.preventDefault();
  }

  let repositionRafId = 0;
  function onPanelMouseMove(e) {
    if (!panelEl || !panelDragState.isDragging) return;
    const dx = e.clientX - panelDragState.startX;
    const dy = e.clientY - panelDragState.startY;
    panelEl.style.left = `${panelDragState.initialLeft + dx}px`;
    panelEl.style.top = `${panelDragState.initialTop + dy}px`;
    if (!repositionRafId) {
      repositionRafId = requestAnimationFrame(() => {
        repositionRafId = 0;
        repositionToasts();
      });
    }
  }

  function onPanelMouseUp() {
    if (!panelEl || !panelDragState.isDragging) return;
    panelDragState.isDragging = false;
    panelPos = {
      top: panelEl.style.top,
      left: panelEl.style.left,
      right: '',
    };
    localStorage.setItem('td_panel_pos', JSON.stringify(panelPos));
  }

  function bindPanelInteractionsOnce() {
    if (!panelEl || panelInteractionsBound) return;
    panelEl.addEventListener('click', onPanelClick);
    panelEl.addEventListener('mousedown', onPanelMouseDown);
    document.addEventListener('mousemove', onPanelMouseMove);
    document.addEventListener('mouseup', onPanelMouseUp);
    panelInteractionsBound = true;
  }

  function unbindPanelInteractions() {
    if (!panelInteractionsBound) return;
    if (panelEl) {
      panelEl.removeEventListener('click', onPanelClick);
      panelEl.removeEventListener('mousedown', onPanelMouseDown);
    }
    document.removeEventListener('mousemove', onPanelMouseMove);
    document.removeEventListener('mouseup', onPanelMouseUp);
    panelDragState.isDragging = false;
    panelInteractionsBound = false;
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
      typeof status.trade_limit.zone === 'string' &&
      typeof status.pending_annotations === 'number' &&
      typeof status.pending_reviews === 'number'
    );
  }

  function isValidTradesPayload(payload) {
    return payload && Array.isArray(payload.trades);
  }

  function repositionToasts() {
    const tc = document.getElementById('td-fill-toasts');
    if (!tc || !panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    tc.style.top = (rect.bottom + 6) + 'px';
    tc.style.left = rect.left + 'px';
    tc.style.width = rect.width + 'px';
  }

  function showFillFeedback(fillData) {
    // Border flash
    if (panelEl) {
      panelEl.classList.remove('td-fill-flash');
      void panelEl.offsetWidth; // reflow to restart animation on rapid fills
      panelEl.classList.add('td-fill-flash');
      panelEl.addEventListener('animationend', function onEnd() {
        panelEl.classList.remove('td-fill-flash');
        panelEl.removeEventListener('animationend', onEnd);
      });
    }

    // Toast notification
    const toastContainer = document.getElementById('td-fill-toasts');
    if (!toastContainer || !fillData) return;

    repositionToasts();

    const symbol = escapeHtml(fillData.symbol || '??');
    const action = (fillData.action || '').toUpperCase();
    const actionClass = action === 'BUY' ? 'td-toast-buy' : 'td-toast-sell';
    const qty = escapeHtml(String(fillData.qty || fillData.quantity || '?'));
    const rawPrice = Number(fillData.price);
    const price = escapeHtml(rawPrice ? rawPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '?');

    const toast = document.createElement('div');
    toast.className = 'td-fill-toast';
    toast.innerHTML = symbol + ' <span class="' + actionClass + '">' + escapeHtml(action) + '</span> ' + qty + ' @ ' + price;
    toastContainer.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('td-toast-removing');
      toast.addEventListener('animationend', function () {
        toast.remove();
      });
    }, 2500);
  }

  function updatePnlInPlace(unrealizedPnl) {
    if (!panelEl) return;
    const container = panelEl.querySelector('.td-open-position');
    if (!container) return;
    const existing = container.querySelector('.td-open-position-pnl');
    if (unrealizedPnl === null) {
      if (existing) { existing.remove(); repositionToasts(); }
      return;
    }
    const cls = `td-open-position-pnl ${unrealizedPnl >= 0 ? 'td-positive' : 'td-negative'}`;
    const text = formatMoney(unrealizedPnl, 2);
    if (existing) {
      existing.className = cls;
      existing.textContent = text;
    } else {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      container.appendChild(el);
      repositionToasts();
    }
  }

  function renderPanel(status, trades) {
    if (!panelEl) return;
    panelEl.innerHTML = buildPanelHTML(status, trades);
    if (panelView === 'prearm') {
      bindPreArmPanelEvents();
    }
    if (status && status.trade_limit && status.trade_limit.golden_complete) {
      panelEl.classList.add('td-golden-border');
    } else {
      panelEl.classList.remove('td-golden-border');
    }
    repositionToasts();
  }

  function syncPendingTradeState(trades) {
    const pendingTrades = sortTradesForDisplay(trades).filter((trade) => isAnnotationIncomplete(trade));
    const pendingIds = new Set(pendingTrades.map((trade) => trade.trade_id));

    if (!pendingTradeIdsInitialized) {
      pendingTradeIdsInitialized = true;
      seenPendingTradeIds = pendingIds;
      return;
    }

    const newlyPendingTrade = pendingTrades.find((trade) => !seenPendingTradeIds.has(trade.trade_id));
    seenPendingTradeIds = pendingIds;

    if (newlyPendingTrade && !document.querySelector('.td-anno-overlay')) {
      void openAnnotationModal({ tradeId: newlyPendingTrade.trade_id });
    }
  }

  function syncPreArmState(previousActiveId, activePreArm) {
    if (activePreArm) {
      preArmSelectionId = activePreArm.playbook_id;
      syncPreArmDraftWithServer(activePreArm);
      if (!hasDirtyPreArmDraft(activePreArm)) {
        preArmSyncError = '';
      }
    } else {
      preArmChecklistSyncPending = false;
      preArmFlushPromise = null;
      preArmSyncError = '';
      clearPreArmDraft();
    }

    if (panelView !== 'prearm') {
      return;
    }

    if (!activePreArm && previousActiveId) {
      closePreArmView();
      return;
    }

    rerenderPanel();
  }

  function setLocalActivePreArm(activePreArm) {
    preArmActiveSnapshot = activePreArm || null;
    if (lastStatus) {
      lastStatus.active_pre_arm = activePreArm || null;
    }
  }

  function hasHydratedActivePreArm() {
    return lastStatus !== null || preArmActiveSnapshot !== undefined;
  }

  async function hydrateActivePreArm(force = false) {
    if (lastStatus) {
      setLocalActivePreArm(lastStatus.active_pre_arm);
      return lastStatus.active_pre_arm || null;
    }
    if (!force && preArmActiveSnapshot !== undefined) {
      return preArmActiveSnapshot;
    }
    if (preArmHydrationPromise) {
      return preArmHydrationPromise;
    }

    preArmHydrationPromise = (async () => {
      try {
        const response = await requestJson('GET', '/pre-arm/active', {
          timeout: STATUS_REQUEST_TIMEOUT_MS,
        });
        const activePreArm = response && Object.prototype.hasOwnProperty.call(response, 'active_pre_arm')
          ? response.active_pre_arm
          : null;
        setLocalActivePreArm(activePreArm);
        syncPreArmState(null, activePreArm);
        return activePreArm;
      } catch (error) {
        console.error('[TD] Failed to hydrate active pre-arm session:', error);
        preArmSyncError = getRequestErrorMessage(error, 'Failed to load active setup');
        rerenderPanel();
        throw error;
      } finally {
        preArmHydrationPromise = null;
        rerenderPanel();
      }
    })();

    rerenderPanel();
    return preArmHydrationPromise;
  }

  async function ensurePreArmReadyForCreate(options = {}) {
    const {
      getActivePreArm = getCurrentActivePreArm,
      hasHydratedPreArm = hasHydratedActivePreArm,
      hydratePreArm = hydrateActivePreArm,
    } = options;

    const currentActive = getActivePreArm();
    if (currentActive) {
      return currentActive;
    }
    if (hasHydratedPreArm()) {
      return null;
    }
    return hydratePreArm(true);
  }

  async function refreshStatus() {
    if (cleanedUp) return;
    if (statusRefreshFailureCount >= 3 && Date.now() < statusRefreshNextAllowedAt) return;
    if (isRefreshingStatus) {
      pendingStatusRefresh = true;
      return;
    }
    isRefreshingStatus = true;

    try {
      const previousActiveId = lastStatus && lastStatus.active_pre_arm
        ? lastStatus.active_pre_arm.id
        : null;
      const [status, tradesPayload] = await Promise.all([
        requestJson('GET', '/status', { timeout: STATUS_REQUEST_TIMEOUT_MS }),
        requestJson('GET', '/trades', { timeout: STATUS_REQUEST_TIMEOUT_MS }),
      ]);

      if (!isValidStatusPayload(status) || !isValidTradesPayload(tradesPayload)) {
        console.error('[TD] Invalid payload received:', { status, tradesPayload });
        showDegraded('Status format error');
        return;
      }

      const pendingReviewCount = status.pending_reviews;
      let nextPendingReviewTargetDate = pendingReviewCount > 0
        ? pendingReviewTargetDate
        : null;
      if (pendingReviewCount > 0) {
        if (shouldRefreshPendingReviewTarget(pendingReviewCount)) {
          if (pendingReviewTargetCount !== pendingReviewCount) {
            nextPendingReviewTargetDate = null;
          }
          try {
            const reviewDaysPayload = await requestJson('GET', '/review/days', { timeout: STATUS_REQUEST_TIMEOUT_MS });
            const resolvedPendingDate = getFirstPendingReviewDate(reviewDaysPayload);
            nextPendingReviewTargetDate = resolvedPendingDate || null;
          } catch (error) {
            console.warn('[TD] Failed to refresh pending review target:', error);
          } finally {
            pendingReviewTargetFetchedAt = Date.now();
            pendingReviewTargetCount = pendingReviewCount;
          }
        }
      } else {
        pendingReviewTargetFetchedAt = 0;
        pendingReviewTargetCount = 0;
      }

      pendingReviewTargetDate = nextPendingReviewTargetDate;

      lastStatus = status;
      setLocalActivePreArm(status.active_pre_arm);
      lastTrades = sortTradesForDisplay(tradesPayload.trades || []);
      lastUpdateTime = new Date();

      renderPanel(status, lastTrades);
      syncPreArmState(previousActiveId, status.active_pre_arm);
      syncPendingTradeState(lastTrades);

      if (status.risk.triggered && !riskAcknowledged) {
        showRiskWarning(status.risk.extra_warning);
      }

      checkTradeLimitWarning(status);
      statusRefreshFailureCount = 0;
    } catch (error) {
      console.error('[TD] Failed to refresh panel data:', error);
      showDegraded(getRequestErrorMessage(error, 'Backend unreachable'));
      statusRefreshFailureCount++;
      if (statusRefreshFailureCount >= 3) {
        const backoffMs = Math.min(120000, 30000 * (statusRefreshFailureCount - 1));
        statusRefreshNextAllowedAt = Date.now() + backoffMs;
      }
    } finally {
      isRefreshingStatus = false;
      if (pendingStatusRefresh && !cleanedUp) {
        pendingStatusRefresh = false;
        refreshStatus();
      }
    }
  }

  function showDegraded(reason = '') {
    if (!panelEl) return;
    const reasonText = reason ? ` · ${reason}` : '';
    const timeStr = lastUpdateTime
      ? lastUpdateTime.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
      : '—';

    // Keep last successful data but show degraded notice.
    if (lastStatus) {
      panelEl.innerHTML = buildPanelHTML(lastStatus, lastTrades);
      const notice = document.createElement('div');
      notice.className = 'td-degraded';
      notice.textContent = `⚠ Data unavailable · Last update ${timeStr}${reasonText}`;
      panelEl.appendChild(notice);
      return;
    }

    // No successful status yet: replace initial loading state with explicit error.
    panelEl.innerHTML = `
      <div class="td-header">
        <span class="td-title">DontBlow</span>
        <span class="td-risk-dot td-risk-green"></span>
      </div>
      <div class="td-degraded">⚠ Data unavailable${reasonText}</div>
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
      ? `<div class="td-modal-extra">${escapeHtml(extraWarning)}</div>`
      : '';

    overlay.innerHTML = `
      <div id="td-risk-modal">
        <div class="td-modal-icon">⚠️</div>
        <div class="td-modal-title">High Emotional Risk</div>
        <div class="td-modal-body">
          2 consecutive losses in the past hour detected.<br>
          You may be in an elevated emotional state.<br><br>
          Pause and reconfirm your plan before the next trade.
        </div>
        ${extraHTML}
        <div class="td-modal-btns">
          <button class="td-btn td-btn-cancel" id="td-risk-cancel">Cancel</button>
          <button class="td-btn td-btn-confirm" id="td-risk-confirm" disabled>Confirm (5s)</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector('#td-risk-cancel');
    const confirmBtn = overlay.querySelector('#td-risk-confirm');
    let countdown = 5;
    let timerId = null;

    const cleanup = () => {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
    };

    const closeOverlay = () => {
      cleanup();
      overlay.remove();
    };

    const onCancel = () => {
      closeOverlay();
    };

    const onConfirm = () => {
      if (confirmBtn.disabled) return;
      riskAcknowledged = true;
      closeOverlay();

      // Notify backend (fire-and-forget)
      fetch(`${API_BASE}/risk/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: new Date().toISOString() }),
      }).catch(() => {});

      // Reset acknowledged flag after cooldown (allow re-trigger for new events)
      setTimeout(() => {
        riskAcknowledged = false;
        console.log('[TD] Risk modal cooldown completed');
      }, 30 * 60 * 1000); // 30 minutes cooldown (was 1 min)
    };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);

    timerId = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        confirmBtn.textContent = `Confirm (${countdown}s)`;
      } else {
        if (timerId) {
          clearInterval(timerId);
          timerId = null;
        }
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm';
      }
    }, 1000);
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
    const title = isRed ? 'Daily Trade Limit Reached' : 'Outside Optimal Range';
    const icon = isRed ? '🛑' : '⚠️';
    const body = isRed
      ? `${count} trades today. You're deviating from plan.<br>Enter your reason to continue:`
      : `${count} trades completed. Optimal pace is 1–2.<br>Confirm to continue?`;

    const reasonHTML = isRed
      ? '<textarea class="td-limit-reason" id="td-limit-reason" placeholder="Why do you need to continue trading?"></textarea>'
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
          <button class="td-btn td-btn-cancel" id="td-limit-cancel">Cancel</button>
          <button class="td-btn td-btn-confirm" id="td-limit-confirm" disabled>Confirm (${countdown}s)</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector('#td-limit-cancel');
    const confirmBtn = overlay.querySelector('#td-limit-confirm');
    const reasonEl = overlay.querySelector('#td-limit-reason');
    let remaining = countdown;
    let countdownDone = false;
    let timerId = null;

    const updateConfirmState = () => {
      if (!countdownDone) {
        confirmBtn.disabled = true;
        return;
      }
      if (isRed) {
        confirmBtn.disabled = !reasonEl || reasonEl.value.trim().length === 0;
        return;
      }
      confirmBtn.disabled = false;
    };

    const cleanup = () => {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      if (reasonEl) reasonEl.removeEventListener('input', updateConfirmState);
    };

    const closeOverlay = () => {
      cleanup();
      overlay.remove();
    };

    const onCancel = () => {
      closeOverlay();
    };

    const onConfirm = () => {
      if (confirmBtn.disabled) return;
      lastWarnedZone = zone;
      closeOverlay();
    };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    if (reasonEl) reasonEl.addEventListener('input', updateConfirmState);

    timerId = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        confirmBtn.textContent = `Confirm (${remaining}s)`;
      } else {
        if (timerId) {
          clearInterval(timerId);
          timerId = null;
        }
        countdownDone = true;
        confirmBtn.textContent = 'Confirm';
        updateConfirmState();
      }
    }, 1000);
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

  let annoTrades = [];
  let annoIdx = 0;
  let annoForm = {};

  function ensurePlaybooksLoaded() {
    if (playbooksCache.length > 0) {
      return Promise.resolve(playbooksCache);
    }
    if (playbookLoadPromise) {
      return playbookLoadPromise;
    }

    playbookLoadPromise = requestJson('GET', '/playbooks')
      .then((response) => {
        playbooksCache = response && Array.isArray(response.playbooks) ? response.playbooks : [];
        if (!preArmSelectionId && playbooksCache[0]) {
          preArmSelectionId = playbooksCache[0].id;
        }
        return playbooksCache;
      })
      .finally(() => {
        playbookLoadPromise = null;
      });

    return playbookLoadPromise;
  }

  function findPlaybookDefinition(playbookId) {
    return playbooksCache.find((playbook) => playbook.id === playbookId) || null;
  }

  function getPlaybookLabel(playbookId) {
    if (playbookId === 'Untagged') return 'Untagged';
    const playbook = findPlaybookDefinition(playbookId);
    return playbook && typeof playbook.name === 'string' && playbook.name.trim()
      ? playbook.name
      : playbookId;
  }

  function buildPlaybookOptions(includeUntagged = false) {
    const ids = playbooksCache.map((playbook) => playbook.id);
    return includeUntagged ? [...ids, 'Untagged'] : ids;
  }

  function loadPreArmDraftFromStorage() {
    try {
      const raw = localStorage.getItem(PRE_ARM_DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.session_id !== 'string') {
        return null;
      }
      return {
        sessionId: parsed.session_id,
        playbookId: typeof parsed.playbook_id === 'string' ? parsed.playbook_id : '',
        checklistState: cloneChecklistState(parsed.checklist_state),
        updatedAt: Number(parsed.updated_at) || Date.now(),
      };
    } catch {
      return null;
    }
  }

  function persistPreArmDraft() {
    if (!preArmDraft) {
      localStorage.removeItem(PRE_ARM_DRAFT_KEY);
      return;
    }
    localStorage.setItem(PRE_ARM_DRAFT_KEY, JSON.stringify({
      session_id: preArmDraft.sessionId,
      playbook_id: preArmDraft.playbookId,
      checklist_state: cloneChecklistState(preArmDraft.checklistState),
      updated_at: preArmDraft.updatedAt,
    }));
  }

  function clearPreArmDraft() {
    preArmDraft = null;
    persistPreArmDraft();
  }

  function getCurrentActivePreArm() {
    if (lastStatus) {
      return lastStatus.active_pre_arm ? lastStatus.active_pre_arm : null;
    }
    return preArmActiveSnapshot === undefined ? null : preArmActiveSnapshot;
  }

  function getDisplayedPreArm(active = getCurrentActivePreArm()) {
    if (!active) return null;
    if (!preArmDraft || preArmDraft.sessionId !== active.id) {
      return active;
    }
    return {
      ...active,
      checklist_state: cloneChecklistState(preArmDraft.checklistState),
    };
  }

  function hasDirtyPreArmDraft(active = getCurrentActivePreArm()) {
    if (!active || !preArmDraft || preArmDraft.sessionId !== active.id) {
      return false;
    }
    return !areChecklistStatesEqual(preArmDraft.checklistState, active.checklist_state);
  }

  function ensurePreArmDraft(active = getCurrentActivePreArm()) {
    if (!active) {
      clearPreArmDraft();
      return null;
    }

    const serverState = cloneChecklistState(active.checklist_state);
    if (
      preArmDraft &&
      preArmDraft.sessionId === active.id &&
      preArmDraft.playbookId === active.playbook_id &&
      preArmDraft.checklistState.length === serverState.length
    ) {
      return preArmDraft;
    }

    preArmDraft = {
      sessionId: active.id,
      playbookId: active.playbook_id,
      checklistState: serverState,
      updatedAt: Date.now(),
    };
    persistPreArmDraft();
    return preArmDraft;
  }

  function syncPreArmDraftWithServer(active) {
    if (!active) {
      clearPreArmDraft();
      return;
    }
    ensurePreArmDraft(active);
  }

  function bindPreArmShortcutOnce() {
    if (preArmShortcutBound) return;
    document.addEventListener('keydown', onPreArmShortcut, true);
    preArmShortcutBound = true;
  }

  function onPreArmShortcut(event) {
    if (!isPreArmShortcutEvent(event) || isEditableElement(event.target)) {
      return;
    }
    event.preventDefault();
    void togglePreArmView();
  }

  function isPreArmShellBusy() {
    return preArmCreatePending || preArmCancelPending;
  }

  function getPreArmStatusDescriptor(active) {
    if (preArmHydrationPromise) {
      return {
        className: 'td-prearm-status',
        text: 'Checking for active setup...',
      };
    }
    if (preArmSyncError) {
      return {
        className: 'td-prearm-status td-prearm-status-error',
        text: preArmSyncError,
      };
    }
    if (preArmCreatePending) {
      return {
        className: 'td-prearm-status',
        text: 'Saving setup session...',
      };
    }
    if (preArmCancelPending) {
      return {
        className: 'td-prearm-status',
        text: 'Canceling active setup...',
      };
    }
    if (preArmChecklistSyncPending) {
      return {
        className: 'td-prearm-status',
        text: 'Saving checklist draft...',
      };
    }
    if (active && hasDirtyPreArmDraft(active)) {
      return {
        className: 'td-prearm-status',
        text: 'Draft saved locally. It will sync when you close this modal or before the next fill is sent.',
      };
    }
    return {
      className: 'td-prearm-status',
      text: active
        ? `${getPreArmShortcutLabel()} returns to main view. Cancel watch removes the active setup.`
        : 'Checklist starts once you click Start.',
    };
  }

  function closePreArmView() {
    panelView = 'normal';
    rerenderPanel();
  }

  async function dismissPreArmView() {
    const active = getCurrentActivePreArm();
    const shouldFlush = !!active && hasDirtyPreArmDraft(active);
    closePreArmView();
    if (!shouldFlush) return;
    try {
      await flushPreArmDraft();
    } catch (error) {
      console.error('[TD] Failed to flush pre-arm draft on dismiss:', error);
    }
  }

  async function openPreArmView() {
    panelView = 'prearm';
    rerenderPanel();

    const [playbooksResult] = await Promise.allSettled([
      ensurePlaybooksLoaded(),
      hydrateActivePreArm(),
    ]);
    if (playbooksResult.status === 'rejected') {
      const error = playbooksResult.reason;
      console.error('[TD] Failed to load playbooks for pre-arm view:', error);
      preArmSyncError = getRequestErrorMessage(error, 'Failed to load playbooks');
      rerenderPanel();
      return;
    }

    if (!preArmSelectionId && playbooksCache[0]) {
      preArmSelectionId = playbooksCache[0].id;
    }
    rerenderPanel();
  }

  async function togglePreArmView() {
    if (panelView !== 'prearm') {
      await openPreArmView();
      return;
    }
    void dismissPreArmView();
  }

  async function startPreArmTracking() {
    if (!preArmSelectionId || isPreArmShellBusy()) return;
    try {
      const activePreArm = await ensurePreArmReadyForCreate();
      if (activePreArm) {
        preArmSyncError = '';
        rerenderPanel();
        return;
      }
    } catch (error) {
      console.error('[TD] Blocking pre-arm create until active session read succeeds:', error);
      rerenderPanel();
      return;
    }

    preArmCreatePending = true;
    preArmSyncError = '';
    rerenderPanel();
    try {
      const response = await requestJson('POST', '/pre-arm', {
        data: { playbook_id: preArmSelectionId },
      });
      setLocalActivePreArm(response.active_pre_arm);
      syncPreArmDraftWithServer(response.active_pre_arm);
      rerenderPanel();
      void refreshStatus();
    } catch (error) {
      console.error('[TD] Failed to create pre-arm session:', error);
      preArmSyncError = getRequestErrorMessage(error, 'Failed to start setup');
    } finally {
      preArmCreatePending = false;
      rerenderPanel();
    }
  }

  async function flushPreArmDraft() {
    if (preArmFlushPromise) return preArmFlushPromise;
    const active = getCurrentActivePreArm();
    if (!active) return null;

    const draft = ensurePreArmDraft(active);
    if (!draft || !hasDirtyPreArmDraft(active)) {
      preArmSyncError = '';
      rerenderPanel();
      return active;
    }

    preArmChecklistSyncPending = true;
    preArmSyncError = '';
    rerenderPanel();

    preArmFlushPromise = (async () => {
      try {
        const response = await requestJson('PATCH', `/pre-arm/${active.id}`, {
          data: { checklist_state: cloneChecklistState(draft.checklistState) },
        });
        setLocalActivePreArm(response.active_pre_arm);
        syncPreArmDraftWithServer(response.active_pre_arm);
        preArmSyncError = '';
        rerenderPanel();
        if (eventSendQueue.length > 0) {
          setTimeout(() => {
            void drainEventSendQueue();
          }, 0);
        }
        return response.active_pre_arm;
      } catch (error) {
        console.error('[TD] Failed to update pre-arm session:', error);
        preArmSyncError = getRequestErrorMessage(error, 'Failed to save setup draft');
        rerenderPanel();
        throw error;
      } finally {
        preArmChecklistSyncPending = false;
        preArmFlushPromise = null;
        rerenderPanel();
      }
    })();

    return preArmFlushPromise;
  }

  function updatePreArmChecklist(index) {
    const active = getCurrentActivePreArm();
    if (!active || isPreArmShellBusy()) return;

    const draft = ensurePreArmDraft(active);
    const nextState = cloneChecklistState(draft ? draft.checklistState : active.checklist_state);
    if (!Number.isInteger(index) || index < 0 || index >= nextState.length) {
      console.warn('[TD] Ignoring checklist update with invalid index:', index);
      return;
    }
    nextState[index] = !nextState[index];
    preArmDraft = {
      sessionId: active.id,
      playbookId: active.playbook_id,
      checklistState: nextState,
      updatedAt: Date.now(),
    };
    preArmSyncError = '';
    persistPreArmDraft();
    rerenderPanel();
  }

  async function cancelActivePreArm() {
    const active = getCurrentActivePreArm();
    if (!active || isPreArmShellBusy()) {
      closePreArmView();
      return;
    }

    preArmCancelPending = true;
    preArmSyncError = '';
    rerenderPanel();
    try {
      await requestJson('DELETE', `/pre-arm/${active.id}`);
      setLocalActivePreArm(null);
      preArmChecklistSyncPending = false;
      preArmFlushPromise = null;
      clearPreArmDraft();
      if (eventSendQueue.length > 0) {
        void drainEventSendQueue();
      }
      preArmSyncError = '';
      closePreArmView();
      void refreshStatus();
    } catch (error) {
      console.error('[TD] Failed to cancel pre-arm session:', error);
      preArmSyncError = getRequestErrorMessage(error, 'Failed to cancel setup');
    } finally {
      preArmCancelPending = false;
      rerenderPanel();
    }
  }

  async function openAnnotationModal(options = {}) {
    if (document.querySelector('.td-anno-overlay')) return;

    try {
      await ensurePlaybooksLoaded();
      const response = await requestJson('GET', '/trades');
      if (!response || !Array.isArray(response.trades) || response.trades.length === 0) {
        console.log('[TD] No trades to annotate');
        return;
      }

      annoTrades = sortTradesForDisplay(response.trades);
      if (options.tradeId) {
        annoIdx = annoTrades.findIndex((trade) => trade.trade_id === options.tradeId);
      } else {
        annoIdx = annoTrades.findIndex((trade) => isAnnotationIncomplete(trade));
      }
      if (annoIdx < 0) annoIdx = 0;
      annoForm = {};
      renderAnnoModal();
    } catch (error) {
      console.error('[TD] Failed to fetch trades for annotation:', error);
    }
  }

  function loadAnnotationFormFromTrade(trade) {
    const annotations = trade.annotations || {};
    return {
      playbook: annotations.playbook || 'Untagged',
      plan_adherence: annotations.plan_adherence || null,
      mindset: annotations.mindset || null,
      error_type: annotations.error_type || 'Untagged',
      note: annotations.note || '',
    };
  }

  function getAnnotationMissingFields(trade, form) {
    const missingFields = [];

    if (!form.playbook || form.playbook === 'Untagged') {
      missingFields.push('Playbook');
    }
    if (!form.plan_adherence) {
      missingFields.push('Plan Adherence');
    }
    if (!form.mindset) {
      missingFields.push('Mindset');
    }
    if (isLosingTrade(trade) && (!form.error_type || form.error_type === 'Untagged')) {
      missingFields.push('Error Type');
    }

    return missingFields;
  }

  function isAnnotationFormComplete(trade, form) {
    return getAnnotationMissingFields(trade, form).length === 0;
  }

  function findNextIncompleteTradeIndex(trades, currentIndex, options = {}) {
    const { includeCurrent = false } = options;
    if (
      includeCurrent &&
      currentIndex >= 0 &&
      currentIndex < trades.length &&
      isAnnotationIncomplete(trades[currentIndex])
    ) {
      return currentIndex;
    }
    for (let i = currentIndex + 1; i < trades.length; i++) {
      if (isAnnotationIncomplete(trades[i])) return i;
    }
    for (let i = 0; i < currentIndex; i++) {
      if (isAnnotationIncomplete(trades[i])) return i;
    }
    return -1;
  }

  function buildAnnotationPayload(trade, form) {
    const payload = {
      playbook: form.playbook || 'Untagged',
      plan_adherence: form.plan_adherence || null,
      mindset: form.mindset || null,
      note: trimToNull(form.note),
    };
    if (isLosingTrade(trade)) {
      payload.error_type = form.error_type || 'Untagged';
    }
    return payload;
  }

  function closeAnnotationModal() {
    const existing = document.querySelector('.td-anno-overlay');
    if (existing) existing.remove();
  }

  function renderAnnoModal() {
    closeAnnotationModal();

    const trade = annoTrades[annoIdx];
    if (!trade) return;

    if (!annoForm._loaded || annoForm._tradeId !== trade.trade_id) {
      annoForm = loadAnnotationFormFromTrade(trade);
      annoForm._loaded = true;
      annoForm._tradeId = trade.trade_id;
    }

    const pnl = getNumericPnl(trade.realized_pnl_net);
    const pnlColor = pnl === null ? '#787b86' : pnl >= 0 ? '#26a69a' : '#ef5350';
    const pnlDisplay = formatMoney(pnl, 2);
    const checkMark = isAnnotationIncomplete(trade) ? '' : '<span class="td-anno-nav-check">✓</span>';
    const nextIncompleteIdx = findNextIncompleteTradeIndex(annoTrades, annoIdx);
    const saveBtnText = nextIncompleteIdx === -1 ? 'Save & Close' : 'Save & Next';
    const setupDisplay = getSetupDisplay(trade);
    const setupCompleteness = typeof trade.annotations.setup_completeness === 'number'
      ? `${Math.round(trade.annotations.setup_completeness * 100)}%`
      : '—';
    const showErrorType = isLosingTrade(trade);
    const missingFields = getAnnotationMissingFields(trade, annoForm);
    const missingFieldSet = new Set(missingFields);
    const saveHint = missingFields.length > 0
      ? `Complete required field${missingFields.length > 1 ? 's' : ''}: ${missingFields.join(', ')}.`
      : '';
    const playbookLabelClass = missingFieldSet.has('Playbook') ? ' td-anno-field-label-missing' : '';
    const planLabelClass = missingFieldSet.has('Plan Adherence') ? ' td-anno-field-label-missing' : '';
    const mindsetLabelClass = missingFieldSet.has('Mindset') ? ' td-anno-field-label-missing' : '';
    const errorLabelClass = missingFieldSet.has('Error Type') ? ' td-anno-field-label-missing' : '';
    const playbookInputClass = missingFieldSet.has('Playbook') ? ' td-anno-input-missing' : '';
    const mindsetInputClass = missingFieldSet.has('Mindset') ? ' td-anno-input-missing' : '';
    const errorInputClass = missingFieldSet.has('Error Type') ? ' td-anno-input-missing' : '';
    const planGroupClass = missingFieldSet.has('Plan Adherence') ? ' td-anno-btn-group-missing' : '';
    const playbookIds = buildPlaybookOptions(true);
    if (annoForm.playbook && !playbookIds.includes(annoForm.playbook)) {
      playbookIds.push(annoForm.playbook);
    }
    const playbookOpts = playbookIds.map((id) => `
      <option value="${escapeHtml(id)}" ${id === annoForm.playbook ? 'selected' : ''}>${escapeHtml(getPlaybookLabel(id))}</option>
    `).join('');
    const mindsetOpts = ['<option value="">—</option>'].concat(MINDSET_OPTIONS.map((value) => `
      <option value="${value}" ${value === annoForm.mindset ? 'selected' : ''}>${value}</option>
    `)).join('');
    const errorOpts = ERROR_TYPES.map((value) => `
      <option value="${value}" ${value === annoForm.error_type ? 'selected' : ''}>${value}</option>
    `).join('');
    const planButtons = PLAN_ADHERENCE_OPTIONS.map((value) => {
      const activeClass = value === annoForm.plan_adherence
        ? `td-anno-btn-active-${value.toLowerCase()}`
        : '';
      return `<button data-plan="${value}" class="${activeClass}">${value}</button>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.className = 'td-anno-overlay';
    overlay.innerHTML = `
      <div class="td-anno-modal">
        <div class="td-anno-modal-header">
          <span class="td-anno-modal-title">📝 Trade Annotations</span>
          <button class="td-anno-close" id="td-anno-close">✕</button>
        </div>
        <div class="td-anno-nav">
          <button class="td-anno-nav-arrow" id="td-anno-prev" ${annoIdx === 0 ? 'disabled' : ''}>◄</button>
          <div class="td-anno-nav-info">
            <div class="td-anno-nav-counter">${annoIdx + 1} / ${annoTrades.length}</div>
            <div class="td-anno-nav-trade">
              ${formatClockTime(trade.open_time)} ${escapeHtml(trade.symbol)} <span style="color:${pnlColor}">${pnlDisplay}</span>${checkMark}
            </div>
          </div>
          <button class="td-anno-nav-arrow" id="td-anno-next" ${annoIdx >= annoTrades.length - 1 ? 'disabled' : ''}>►</button>
        </div>
        <div class="td-anno-summary">
          <div class="td-anno-summary-card">
            <div class="td-anno-summary-label">Playbook</div>
            <div class="td-anno-summary-value">${escapeHtml(trade.annotations.playbook || 'Untagged')}</div>
          </div>
          <div class="td-anno-summary-card">
            <div class="td-anno-summary-label">Setup</div>
            <div class="td-anno-summary-value">${escapeHtml(setupDisplay.text)}</div>
          </div>
          <div class="td-anno-summary-card">
            <div class="td-anno-summary-label">Completeness</div>
            <div class="td-anno-summary-value">${setupCompleteness}</div>
          </div>
        </div>
        <div class="td-anno-field">
          <span class="td-anno-field-label${playbookLabelClass}">Playbook<span class="td-anno-required">*</span></span>
          <div class="td-anno-field-body">
            <select class="td-anno-select${playbookInputClass}" id="td-anno-playbook">${playbookOpts}</select>
            ${missingFieldSet.has('Playbook') ? '<div class="td-anno-field-hint">Choose a playbook before moving on.</div>' : ''}
          </div>
        </div>
        <div class="td-anno-field">
          <span class="td-anno-field-label${planLabelClass}">Plan Adherence<span class="td-anno-required">*</span></span>
          <div class="td-anno-field-body">
            <div class="td-anno-btn-group${planGroupClass}" id="td-anno-plan-group">${planButtons}</div>
            ${missingFieldSet.has('Plan Adherence') ? '<div class="td-anno-field-hint">Select Yes, Partial, or No before continuing.</div>' : ''}
          </div>
        </div>
        <div class="td-anno-field">
          <span class="td-anno-field-label${mindsetLabelClass}">Mindset<span class="td-anno-required">*</span></span>
          <div class="td-anno-field-body">
            <select class="td-anno-select${mindsetInputClass}" id="td-anno-mindset">${mindsetOpts}</select>
            ${missingFieldSet.has('Mindset') ? '<div class="td-anno-field-hint">Pick the mindset that best matches the trade.</div>' : ''}
          </div>
        </div>
        ${showErrorType ? `<div class="td-anno-field">
          <span class="td-anno-field-label${errorLabelClass}">Error Type<span class="td-anno-required">*</span></span>
          <div class="td-anno-field-body">
            <select class="td-anno-select${errorInputClass}" id="td-anno-error">${errorOpts}</select>
            ${missingFieldSet.has('Error Type') ? '<div class="td-anno-field-hint">Choose the main mistake before moving on.</div>' : ''}
          </div>
        </div>` : ''}
        <div class="td-anno-field">
          <span class="td-anno-field-label">Note</span>
          <input class="td-anno-note" id="td-anno-note" type="text" maxlength="160" value="${escapeHtml(annoForm.note || '')}" placeholder="Optional one-liner...">
        </div>
        ${saveHint ? `<div class="td-anno-save-hint">${escapeHtml(saveHint)}</div>` : ''}
        <button class="td-anno-save-btn" id="td-anno-save" ${missingFields.length > 0 ? 'disabled' : ''}>${saveBtnText}</button>
      </div>
    `;

    document.body.appendChild(overlay);
    setupAnnoModalEvents(overlay);
  }

  function setupAnnoModalEvents(overlay) {
    overlay.querySelector('#td-anno-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

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

    overlay.querySelector('#td-anno-playbook').addEventListener('change', (e) => {
      annoForm.playbook = e.target.value;
      renderAnnoModal();
    });

    overlay.querySelectorAll('[data-plan]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.dataset.plan;
        annoForm.plan_adherence = annoForm.plan_adherence === value ? null : value;
        renderAnnoModal();
      });
    });

    overlay.querySelector('#td-anno-mindset').addEventListener('change', (e) => {
      annoForm.mindset = e.target.value || null;
      renderAnnoModal();
    });

    const errorSelect = overlay.querySelector('#td-anno-error');
    if (errorSelect) {
      errorSelect.addEventListener('change', (e) => {
        annoForm.error_type = e.target.value;
        renderAnnoModal();
      });
    }

    overlay.querySelector('#td-anno-note').addEventListener('input', (e) => {
      annoForm.note = e.target.value;
    });

    overlay.querySelector('#td-anno-save').addEventListener('click', () => {
      void saveAnnotation(overlay);
    });
  }

  async function saveAnnotation(overlay) {
    const trade = annoTrades[annoIdx];
    if (!trade) return;
    if (!isAnnotationFormComplete(trade, annoForm)) {
      renderAnnoModal();
      return;
    }

    const saveBtn = overlay.querySelector('#td-anno-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const payload = buildAnnotationPayload(trade, annoForm);

    try {
      const updated = await requestJson('PATCH', `/trades/${trade.trade_id}/annotations`, {
        data: payload,
      });
      console.log('[TD] ✅ Annotation saved for', trade.trade_id);

      annoTrades[annoIdx] = updated;
      lastTrades = lastTrades.map((item) => item.trade_id === updated.trade_id ? updated : item);

      const nextIdx = findNextIncompleteTradeIndex(annoTrades, annoIdx, { includeCurrent: true });
      if (nextIdx === -1) {
        overlay.remove();
      } else {
        annoIdx = nextIdx;
        annoForm = {};
        renderAnnoModal();
      }

      await refreshStatus();
    } catch (error) {
      console.error('[TD] ❌ Annotation save error:', error);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save failed — Retry';
    }
  }

  // ============================================================
  // Initialize
  // ============================================================

  if (IS_TEST_MODE) {
    globalThis.__TD_TEST_HOOKS__ = {
      buildAnnotationPayload,
      buildReviewPageUrl,
      buildPanelHTML,
      ensurePreArmReadyForCreate,
      formatPendingReviewLabel,
      findNextIncompleteTradeIndex,
      getAnnotationMissingFields,
      getFirstPendingReviewDate,
      isAnnotationFormComplete,
      isValidStatusPayload,
      shouldRefreshPendingReviewTarget,
    };
    return;
  }

  registerLifecycleCleanup();
  bindPreArmShortcutOnce();
  initPanel();

  // Start DOM scraper after page settles (TV renders Account Manager lazily)
  scraperStartTimeoutId = setTimeout(startScraper, 3000);

  console.log('[TD] 🚀 Trading Discipline System initialized');

})();
