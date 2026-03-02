/* app.js — Polymarket Scanner: WebSocket client, backend, and UI */
(function () {
  "use strict";

  // ============================================
  // CONFIG
  // ============================================
  const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  const CGI_BIN = "__CGI_BIN__";
  const API_URL = `${CGI_BIN}/api.py`;
  const PING_INTERVAL = 15000;
  const MAX_RECONNECT_DELAY = 30000;
  const NEW_BADGE_DURATION = 60000;

  // ============================================
  // STATE
  // ============================================
  let markets = [];
  let ws = null;
  let pingTimer = null;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let connectTime = null;
  let uptimeTimer = null;
  let lastEventTime = null;
  let lastEventTimer = null;
  let soundEnabled = true;
  let searchQuery = "";
  let expandedRowId = null;
  let sidebarOpen = true;

  // ============================================
  // DOM REFS
  // ============================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    dashboard: $("#dashboard"),
    connStatus: $("#conn-status"),
    connLabel: $("#conn-label"),
    statMarkets: $("#stat-markets"),
    statLastEvent: $("#stat-last-event"),
    statUptime: $("#stat-uptime"),
    kpiTotal: $("#kpi-total"),
    kpiToday: $("#kpi-today"),
    kpiHour: $("#kpi-hour"),
    kpiUptime: $("#kpi-uptime"),
    searchInput: $("#search-input"),
    resultCount: $("#result-count"),
    exportCsv: $("#export-csv"),
    skeletonLoader: $("#skeleton-loader"),
    marketsTable: $("#markets-table"),
    marketsTbody: $("#markets-tbody"),
    emptyState: $("#empty-state"),
    mobileCards: $("#mobile-cards"),
    tableScroll: $("#table-scroll"),
    sidebar: $("#sidebar"),
    sidebarOverlay: $("#sidebar-overlay"),
    sidebarToggle: $("#sidebar-toggle"),
    closeSidebar: $("#close-sidebar"),
    clearFeed: $("#clear-feed"),
    feedContainer: $("#feed-container"),
    soundToggle: $("#sound-toggle"),
    toast: $("#toast"),
  };

  // ============================================
  // THEME TOGGLE
  // ============================================
  (function initTheme() {
    const toggle = $("[data-theme-toggle]");
    const root = document.documentElement;
    let theme = "dark"; // Default dark for finance dashboard
    root.setAttribute("data-theme", theme);

    if (toggle) {
      toggle.addEventListener("click", () => {
        theme = theme === "dark" ? "light" : "dark";
        root.setAttribute("data-theme", theme);
        toggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
        toggle.innerHTML =
          theme === "dark"
            ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      });
    }
  })();

  // ============================================
  // UTILITIES
  // ============================================
  function timeAgo(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function truncateAddr(addr) {
    if (!addr || addr.length < 12) return addr || "—";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  function formatDatetime(dateStr) {
    try {
      const d = new Date(dateStr);
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      });
    } catch { return dateStr; }
  }

  function nowISO() { return new Date().toISOString(); }
  function nowTime() { return new Date().toLocaleTimeString("en-US", { hour12: false }); }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // ============================================
  // SOUND
  // ============================================
  let audioCtx = null;
  function playNotificationSound() {
    if (!soundEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.value = 0.08;
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) { /* audio not available */ }
  }

  // ============================================
  // TOAST
  // ============================================
  let toastTimer = null;
  function showToast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 2500);
  }

  // ============================================
  // FEED LOG
  // ============================================
  function addFeedLine(type, msg, cls = "") {
    const line = document.createElement("div");
    line.className = "feed-line";
    line.innerHTML = `<span class="feed-ts">${nowTime()}</span><span class="feed-type">[${escapeHtml(type)}]</span><span class="feed-msg ${cls}">${escapeHtml(msg)}</span>`;
    dom.feedContainer.appendChild(line);
    // Keep max 500 lines
    while (dom.feedContainer.children.length > 500) {
      dom.feedContainer.removeChild(dom.feedContainer.firstChild);
    }
    dom.feedContainer.scrollTop = dom.feedContainer.scrollHeight;
  }

  // ============================================
  // CONNECTION STATUS
  // ============================================
  function setConnectionStatus(status) {
    dom.connStatus.className = `connection-status ${status}`;
    const labels = { connected: "Connected", disconnected: "Disconnected", reconnecting: "Reconnecting..." };
    dom.connLabel.textContent = labels[status] || status;
  }

  // ============================================
  // KPI UPDATE
  // ============================================
  function updateKPIs() {
    const total = markets.length;
    const now = Date.now();
    const dayAgo = now - 86400000;
    const hourAgo = now - 3600000;

    let today = 0, hour = 0;
    for (const m of markets) {
      const t = new Date(m.created_at || m.event_timestamp).getTime();
      if (t > dayAgo) today++;
      if (t > hourAgo) hour++;
    }

    animateNumber(dom.kpiTotal, total);
    animateNumber(dom.kpiToday, today);
    animateNumber(dom.kpiHour, hour);
    dom.statMarkets.textContent = total;
  }

  function animateNumber(el, target) {
    const current = parseInt(el.textContent.replace(/,/g, "")) || 0;
    if (current === target) return;
    const diff = target - current;
    const steps = Math.min(Math.abs(diff), 20);
    const stepSize = diff / steps;
    let i = 0;
    const interval = setInterval(() => {
      i++;
      if (i >= steps) {
        el.textContent = target.toLocaleString();
        clearInterval(interval);
      } else {
        el.textContent = Math.round(current + stepSize * i).toLocaleString();
      }
    }, 30);
  }

  // ============================================
  // UPTIME TIMER
  // ============================================
  function startUptimeTimer() {
    connectTime = Date.now();
    clearInterval(uptimeTimer);
    uptimeTimer = setInterval(() => {
      const up = formatUptime(Date.now() - connectTime);
      dom.statUptime.textContent = up;
      dom.kpiUptime.textContent = up;
    }, 1000);
  }

  function stopUptimeTimer() {
    clearInterval(uptimeTimer);
  }

  // ============================================
  // LAST EVENT TIMER
  // ============================================
  function updateLastEvent() {
    lastEventTime = Date.now();
    dom.statLastEvent.textContent = "just now";
    clearInterval(lastEventTimer);
    lastEventTimer = setInterval(() => {
      if (!lastEventTime) return;
      const diff = Math.floor((Date.now() - lastEventTime) / 1000);
      if (diff < 60) dom.statLastEvent.textContent = `${diff}s ago`;
      else if (diff < 3600) dom.statLastEvent.textContent = `${Math.floor(diff / 60)}m ago`;
      else dom.statLastEvent.textContent = `${Math.floor(diff / 3600)}h ago`;
    }, 5000);
  }

  // ============================================
  // BACKEND API
  // ============================================
  async function fetchMarkets() {
    try {
      const resp = await fetch(`${API_URL}?limit=500`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      addFeedLine("error", `Fetch failed: ${e.message}`, "error");
      return [];
    }
  }

  async function saveMarket(data) {
    try {
      await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    } catch (e) {
      addFeedLine("error", `Save failed: ${e.message}`, "error");
    }
  }

  // ============================================
  // RENDER TABLE
  // ============================================
  function getFilteredMarkets() {
    if (!searchQuery) return markets;
    const q = searchQuery.toLowerCase();
    return markets.filter(
      (m) =>
        (m.question || "").toLowerCase().includes(q) ||
        (m.slug || "").toLowerCase().includes(q) ||
        (m.market_id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
    );
  }

  function renderTable() {
    const filtered = getFilteredMarkets();
    dom.resultCount.textContent = searchQuery ? `${filtered.length} of ${markets.length}` : "";

    // Show/hide states
    dom.skeletonLoader.style.display = "none";
    if (filtered.length === 0) {
      dom.marketsTable.style.display = "none";
      dom.emptyState.style.display = "flex";
    } else {
      dom.marketsTable.style.display = "table";
      dom.emptyState.style.display = "none";
    }

    // Desktop table
    const tbody = dom.marketsTbody;
    tbody.innerHTML = "";
    for (const m of filtered) {
      const tr = document.createElement("tr");
      tr.dataset.id = m.market_id || m.id;
      const isNew = m._isNew;
      if (isNew) tr.classList.add("row-new");

      const ts = m.created_at || m.event_timestamp || "";
      const outcomes = Array.isArray(m.outcomes) ? m.outcomes.join(" / ") : (m.outcomes || "—");
      const slug = m.slug || "";

      tr.innerHTML = `
        <td class="cell-time" title="${escapeHtml(formatDatetime(ts))}">${escapeHtml(timeAgo(ts))}</td>
        <td class="cell-question">${escapeHtml(m.question || "—")}</td>
        <td class="cell-outcomes">${escapeHtml(outcomes)}</td>
        <td class="cell-id" title="Click to copy: ${escapeHtml(m.market_id || "")}" data-copy="${escapeHtml(m.market_id || "")}">${escapeHtml(truncateAddr(m.market_id))}</td>
        <td class="cell-slug">${slug ? `<a href="https://polymarket.com/event/${encodeURIComponent(slug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(slug.length > 30 ? slug.slice(0, 27) + "..." : slug)}</a>` : "—"}</td>
        <td>${isNew ? '<span class="badge-new">NEW</span>' : ""}</td>
      `;

      // Click to expand
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a") || e.target.closest(".cell-id")) return;
        toggleRowDetail(m, tr);
      });

      tbody.appendChild(tr);

      // If expanded
      if (expandedRowId === (m.market_id || m.id)) {
        appendDetailRow(m, tr);
      }
    }

    // Copy on click for market ID cells
    tbody.querySelectorAll(".cell-id").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const text = el.dataset.copy;
        if (text) copyToClipboard(text);
      });
    });

    // Mobile cards
    renderMobileCards(filtered);
  }

  function toggleRowDetail(market, tr) {
    const id = market.market_id || market.id;
    if (expandedRowId === id) {
      expandedRowId = null;
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("row-detail")) next.remove();
    } else {
      // Close previous
      const prev = dom.marketsTbody.querySelector(".row-detail");
      if (prev) prev.remove();
      expandedRowId = id;
      appendDetailRow(market, tr);
    }
  }

  function appendDetailRow(market, afterTr) {
    const detailTr = document.createElement("tr");
    detailTr.className = "row-detail";
    const assetsIds = Array.isArray(market.assets_ids) ? market.assets_ids : [];
    detailTr.innerHTML = `
      <td colspan="6">
        <div class="detail-content">
          <div class="detail-description">${escapeHtml(market.description || "No description available.")}</div>
          <div>
            <div class="detail-label">Contract Address</div>
            <button class="copy-btn" data-copy="${escapeHtml(market.market_address || market.market_id || "")}">
              ${escapeHtml(market.market_address || market.market_id || "—")}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
          <div>
            <div class="detail-label">Asset IDs (${assetsIds.length})</div>
            ${assetsIds.length > 0
              ? assetsIds.map((a) => `<button class="copy-btn" data-copy="${escapeHtml(a)}" style="margin-bottom:var(--space-1);display:block;">${escapeHtml(truncateAddr(a))} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`).join("")
              : '<span class="detail-value">—</span>'}
          </div>
        </div>
      </td>
    `;

    // Copy buttons
    detailTr.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyToClipboard(btn.dataset.copy);
      });
    });

    afterTr.after(detailTr);
  }

  function renderMobileCards(filtered) {
    dom.mobileCards.innerHTML = "";
    for (const m of filtered) {
      const card = document.createElement("div");
      card.className = "mobile-card";
      if (m._isNew) card.classList.add("row-new");
      const ts = m.created_at || m.event_timestamp || "";
      const outcomes = Array.isArray(m.outcomes) ? m.outcomes.join(" / ") : (m.outcomes || "—");

      card.innerHTML = `
        <div class="mobile-card-header">
          <span class="mobile-card-question">${escapeHtml(m.question || "—")}</span>
          ${m._isNew ? '<span class="badge-new">NEW</span>' : ""}
        </div>
        <div class="mobile-card-meta">
          <span>${escapeHtml(timeAgo(ts))}</span>
          <span>${escapeHtml(outcomes)}</span>
          <span style="font-family:var(--font-mono);color:var(--color-text-faint);">${escapeHtml(truncateAddr(m.market_id))}</span>
        </div>
      `;

      card.addEventListener("click", () => {
        if (m.slug) {
          window.open(`https://polymarket.com/event/${encodeURIComponent(m.slug)}`, "_blank", "noopener,noreferrer");
        }
      });

      dom.mobileCards.appendChild(card);
    }
  }

  function copyToClipboard(text) {
    if (!text) return;
    try {
      navigator.clipboard.writeText(text).then(() => showToast("Copied to clipboard"));
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied to clipboard");
    }
  }

  // ============================================
  // EXPORT CSV
  // ============================================
  function exportCSV() {
    if (markets.length === 0) return showToast("No markets to export");
    const headers = ["Timestamp", "Question", "Outcomes", "Market ID", "Slug", "Description", "Asset IDs"];
    const rows = markets.map((m) => [
      m.created_at || m.event_timestamp || "",
      `"${(m.question || "").replace(/"/g, '""')}"`,
      Array.isArray(m.outcomes) ? m.outcomes.join(" / ") : (m.outcomes || ""),
      m.market_id || "",
      m.slug || "",
      `"${(m.description || "").replace(/"/g, '""')}"`,
      Array.isArray(m.assets_ids) ? m.assets_ids.join("; ") : "",
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polymarket-markets-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${markets.length} markets`);
  }

  // ============================================
  // WEBSOCKET
  // ============================================
  function connectWS() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    setConnectionStatus("reconnecting");
    addFeedLine("ws", "Connecting...", "warn");

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      addFeedLine("error", `WS create failed: ${e.message}`, "error");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      setConnectionStatus("connected");
      reconnectDelay = 1000;
      addFeedLine("ws", `Connected to ${WS_URL}`);

      // Send subscription
      const sub = JSON.stringify({
        assets_ids: [],
        type: "market",
        custom_feature_enabled: true,
      });
      ws.send(sub);
      addFeedLine("sub", "Subscribed to new_market events");

      // Start keepalive
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send("{}");
          addFeedLine("ping", "Keepalive sent", "info");
        }
      }, PING_INTERVAL);

      startUptimeTimer();
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // Handle array of events
        const events = Array.isArray(data) ? data : [data];

        for (const event of events) {
          if (event.event_type === "new_market" || event.type === "new_market") {
            handleNewMarket(event);
          } else if (event.event_type || event.type) {
            addFeedLine("event", `${event.event_type || event.type}: ${event.question || event.id || "unknown"}`, "info");
          }
        }
      } catch (e) {
        // Might be a non-JSON keepalive response or other message
        if (evt.data && evt.data !== "{}") {
          addFeedLine("msg", String(evt.data).slice(0, 100), "info");
        }
      }
    };

    ws.onerror = (err) => {
      addFeedLine("error", "WebSocket error", "error");
    };

    ws.onclose = (evt) => {
      setConnectionStatus("disconnected");
      clearInterval(pingTimer);
      stopUptimeTimer();
      addFeedLine("ws", `Disconnected (code: ${evt.code})`, "warn");
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    addFeedLine("ws", `Reconnecting in ${reconnectDelay / 1000}s...`, "warn");
    setConnectionStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connectWS();
    }, reconnectDelay);
  }

  function handleNewMarket(event) {
    const market = {
      market_id: event.id || event.market_id || "",
      question: event.question || "",
      market_address: event.market || event.market_address || "",
      slug: event.slug || "",
      description: event.description || "",
      assets_ids: event.assets_ids || [],
      outcomes: event.outcomes || [],
      event_timestamp: event.timestamp || nowISO(),
      created_at: nowISO(),
      _isNew: true,
    };

    // Check for duplicate
    if (markets.some((m) => m.market_id === market.market_id && market.market_id)) return;

    // Add to front
    markets.unshift(market);

    // Save to backend
    saveMarket(market);

    // Update UI
    renderTable();
    updateKPIs();
    updateLastEvent();
    playNotificationSound();

    addFeedLine("new_market", `"${market.question.slice(0, 60)}${market.question.length > 60 ? "..." : ""}" — saved`);

    // Remove NEW badge after timeout
    setTimeout(() => {
      market._isNew = false;
      renderTable();
    }, NEW_BADGE_DURATION);
  }

  // ============================================
  // AUTO-UPDATE RELATIVE TIMES
  // ============================================
  setInterval(() => {
    dom.marketsTbody.querySelectorAll(".cell-time").forEach((el) => {
      const ts = el.getAttribute("title");
      if (ts) {
        // We stored the formatted datetime in title, need to parse the raw ts from the market
        // Instead, just re-render on the timer - simpler approach done below
      }
    });
    // Just re-render every 30s to update relative times
    renderTable();
  }, 30000);

  // ============================================
  // INIT
  // ============================================
  async function init() {
    // Load stored markets
    addFeedLine("sys", "Loading stored markets...", "info");
    const stored = await fetchMarkets();
    if (stored && stored.length > 0) {
      markets = stored.map((m) => ({ ...m, _isNew: false }));
      addFeedLine("sys", `Loaded ${markets.length} markets from storage`);
    }

    renderTable();
    updateKPIs();

    // Connect WebSocket
    connectWS();

    // Event listeners
    dom.searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      renderTable();
    });

    dom.exportCsv.addEventListener("click", exportCSV);

    dom.soundToggle.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      dom.soundToggle.classList.toggle("muted", !soundEnabled);
      dom.soundToggle.setAttribute("aria-label", soundEnabled ? "Mute sound" : "Unmute sound");
      showToast(soundEnabled ? "Sound enabled" : "Sound muted");
    });

    // Sidebar toggle (mobile)
    dom.sidebarToggle.addEventListener("click", () => {
      dom.sidebar.classList.toggle("mobile-open");
      dom.sidebarOverlay.classList.toggle("active");
    });

    dom.closeSidebar.addEventListener("click", () => {
      dom.sidebar.classList.remove("mobile-open");
      dom.sidebarOverlay.classList.remove("active");
      // On desktop, hide sidebar
      if (window.innerWidth >= 1024) {
        sidebarOpen = !sidebarOpen;
        dom.dashboard.classList.toggle("sidebar-open", sidebarOpen);
        dom.sidebar.style.display = sidebarOpen ? "" : "none";
      }
    });

    dom.sidebarOverlay.addEventListener("click", () => {
      dom.sidebar.classList.remove("mobile-open");
      dom.sidebarOverlay.classList.remove("active");
    });

    dom.clearFeed.addEventListener("click", () => {
      dom.feedContainer.innerHTML = "";
      addFeedLine("sys", "Feed cleared");
    });

    // Sidebar toggle for desktop via sidebar-toggle button
    dom.sidebarToggle.addEventListener("click", () => {
      if (window.innerWidth >= 1024) {
        sidebarOpen = !sidebarOpen;
        dom.dashboard.classList.toggle("sidebar-open", sidebarOpen);
        if (!sidebarOpen) dom.sidebar.style.display = "none";
        else dom.sidebar.style.display = "";
      }
    });
  }

  // Boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
