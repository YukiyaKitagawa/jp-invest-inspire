const SUPABASE_URL = "https://jkacguhaabaqtrjaahgl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprYWNndWhhYWJhcXRyamFhaGdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNTIxNjAsImV4cCI6MjA5NzcyODE2MH0.6BnIs9aq4pM9DKicbdiEBG95fvw4Oyihd4YW4_Q1U4c";

const DISPLAY_RANK_LIMIT = 25;

const SENTIMENT_LABELS = { positive: "ポジティブ", negative: "ネガティブ", neutral: "中立" };

const GLOSSARY = {
  sentiment: "AIが関連ニュースを読み、その銘柄にとって「プラス材料」「マイナス材料」「どちらでもない」のいずれかを判定した結果です。あくまでAIの一次判断であり、売買の推奨ではありません。",
  impact: "そのニュースが株価に与える影響の大きさを、AIが1〜10の数字で評価したものです。数字が大きいほど「見逃さない方がよい」重要度が高いニュースと考えられます。",
  change: "前営業日の終値と比べた株価の変化率です。プラスは値上がり、マイナスは値下がりを意味します。数%の変動は日常的にあるため、過度に一喜一憂する必要はありません。",
  sector: "この企業が属する業種・分野の分類です。同じセクターの銘柄は似た要因（金利、規制、需要動向など）で値動きが連動することがあります。",
  market_cap: "時価総額は「株価 × 発行済み株式数」で計算される、企業の市場での評価規模です。大きいほど一般的に値動きが安定しやすく、小さいほど値動きが大きくなりやすい傾向があります。",
  per_ratio: "PER（株価収益率）は、株価が1株当たり利益（EPS）の何倍まで買われているかを示す指標です。数値が低いほど「割安」、高いほど「割高」とされることが多いですが、業種によって平均的な水準が大きく異なるため、同業他社と比較して見るのが基本です。",
  pbr_ratio: "PBR（株価純資産倍率）は、株価が1株当たり純資産（会社を清算した場合の取り分の目安）の何倍まで買われているかを示す指標です。1倍が「解散価値」の目安とされ、1倍を下回ると割安と見られることがありますが、業績が悪化傾向の企業は割安に見えても注意が必要です。",
  roe: "ROE（自己資本利益率）は、株主が出資したお金（自己資本）を使って、企業がどれだけ効率よく利益を生み出しているかを示す指標です（%）。一般的に8〜10%以上が優良とされることが多いですが、業種によって水準が異なるため、同業他社との比較が基本です。",
  dividend_yield: "配当利回りは、株価に対して1年間でどれくらいの配当金を受け取れるかを示す割合（%）です。高いほど配当狙いの投資には魅力的に見えますが、業績悪化により減配・無配になるリスクもあるため、利回りの高さだけで判断しないことが大切です。",
  disclosure: "適時開示は、上場企業が決算内容や業績の修正、他社との提携など投資判断に重要な情報を、証券取引所を通じて公式に発表する制度です。ニュース記事のような憶測や解釈が入る前の「一次情報」として確認できます。",
};

function infoIcon(term) {
  const text = GLOSSARY[term];
  if (!text) return "";
  return `<span class="info-icon" data-term="${term}" tabindex="0" role="button" aria-label="用語解説">ⓘ<span class="info-tooltip">${text}</span></span>`;
}

document.addEventListener("click", (e) => {
  const icon = e.target.closest(".info-icon");
  document.querySelectorAll(".info-icon.open").forEach((el) => {
    if (el !== icon) el.classList.remove("open");
  });
  if (icon) {
    icon.classList.toggle("open");
    e.stopPropagation();
  }
});

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let latestRows = [];
let tickerRows = [];
let tickerMap = new Map();

function displayName(symbol) {
  return tickerMap.get(symbol)?.company_name || symbol;
}

const els = {
  cardGrid: document.getElementById("cardGrid"),
  summaryCards: document.getElementById("summaryCards"),
  tickerChanges: document.getElementById("tickerChanges"),
  lastUpdated: document.getElementById("lastUpdated"),
  searchInput: document.getElementById("searchInput"),
  sectorFilter: document.getElementById("sectorFilter"),
  sentimentFilter: document.getElementById("sentimentFilter"),
  sortSelect: document.getElementById("sortSelect"),
  trendTickerSelect: document.getElementById("trendTickerSelect"),
  periodToggle: document.getElementById("periodToggle"),
  trendChart: document.getElementById("trendChart"),
  trendEmptyState: document.getElementById("trendEmptyState"),
  trendTableBody: document.getElementById("trendTableBody"),
  intradayTickerSelect: document.getElementById("intradayTickerSelect"),
  intradayChart: document.getElementById("intradayChart"),
  intradayEmptyState: document.getElementById("intradayEmptyState"),
  intradayTableBody: document.getElementById("intradayTableBody"),
};

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeDays(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "今日";
  return `${days}日前`;
}

function formatYen(value) {
  if (value === null || value === undefined || isNaN(Number(value))) return "データなし";
  return `¥${Math.round(Number(value)).toLocaleString("ja-JP")}`;
}

function formatMarketCap(value) {
  if (value === null || value === undefined || isNaN(Number(value))) return "データなし";
  const v = Number(value);
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}兆円`;
  if (v >= 1e8) return `${(v / 1e8).toFixed(0)}億円`;
  return `${v.toLocaleString("ja-JP")}円`;
}

function formatRatio(value, unit) {
  if (value === null || value === undefined || isNaN(Number(value))) return "データなし";
  return `${Number(value).toFixed(1)}${unit}`;
}

// JSTの暦日で "YYYY-MM-DD" を返す（イントラデイの「今日」判定に使用）
function jstDateKey(input = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(input);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function loadData() {
  const [{ data: latest, error: latestError }, { data: tickers, error: tickerError }] = await Promise.all([
    client.from("jp_stock_intelligence_latest").select("*"),
    client.from("jp_stock_tickers").select("*"),
  ]);

  if (latestError || tickerError) {
    const message = (latestError && latestError.message) || (tickerError && tickerError.message);
    els.cardGrid.innerHTML = `<p class="error-state">データの取得に失敗しました: ${message}</p>`;
    els.lastUpdated.textContent = "取得エラー";
    return;
  }

  tickerRows = tickers ?? [];
  tickerMap = new Map(tickerRows.map((t) => [t.ticker_symbol, t]));
  // 収集対象は上位50(is_active)だが、ダッシュボード表示は上位25(rank)のみ
  const displaySymbols = new Set(
    tickerRows.filter((t) => t.is_active && t.rank !== null && t.rank <= DISPLAY_RANK_LIMIT).map((t) => t.ticker_symbol),
  );
  latestRows = (latest ?? []).filter((r) => displaySymbols.has(r.ticker_symbol));

  populateSectorFilter();
  renderLastUpdated();
  renderSummary();
  renderCards();
  renderTickerChanges();
  populateTrendTickerSelect();
  loadTrendChart();
  populateIntradayTickerSelect();
  loadIntradayChart();
}

function populateSectorFilter() {
  const sectors = Array.from(
    new Set(latestRows.map((r) => tickerMap.get(r.ticker_symbol)?.sector_category).filter(Boolean)),
  ).sort();
  for (const sector of sectors) {
    const opt = document.createElement("option");
    opt.value = sector;
    opt.textContent = sector;
    els.sectorFilter.appendChild(opt);
  }
}

function renderLastUpdated() {
  const timestamps = latestRows.map((r) => r.recorded_at).filter(Boolean);
  if (timestamps.length === 0) {
    els.lastUpdated.textContent = "データがありません";
    return;
  }
  const latestTime = timestamps.sort().at(-1);
  els.lastUpdated.textContent = `最終更新: ${formatDateTime(latestTime)}`;
}

function renderSummary() {
  const total = latestRows.length;
  const positive = latestRows.filter((r) => r.market_sentiment === "positive").length;
  const negative = latestRows.filter((r) => r.market_sentiment === "negative").length;
  const neutral = latestRows.filter((r) => r.market_sentiment === "neutral").length;

  els.summaryCards.innerHTML = `
    <div class="summary-card"><div class="value">${total}</div><div class="label">追跡銘柄数</div></div>
    <div class="summary-card"><div class="value" style="color:var(--positive)">${positive}</div><div class="label">ポジティブ</div></div>
    <div class="summary-card"><div class="value" style="color:var(--neutral)">${neutral}</div><div class="label">中立</div></div>
    <div class="summary-card"><div class="value" style="color:var(--negative)">${negative}</div><div class="label">ネガティブ</div></div>
  `;
}

function getFilteredSortedRows() {
  const search = els.searchInput.value.trim().toLowerCase();
  const sector = els.sectorFilter.value;
  const sentiment = els.sentimentFilter.value;
  const sort = els.sortSelect.value;

  let rows = latestRows.filter((r) => {
    if (search) {
      const haystack = `${r.ticker_symbol} ${displayName(r.ticker_symbol)}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (sector && tickerMap.get(r.ticker_symbol)?.sector_category !== sector) return false;
    if (sentiment && r.market_sentiment !== sentiment) return false;
    return true;
  });

  const byNum = (v) => (v === null || v === undefined ? -Infinity : Number(v));

  switch (sort) {
    case "change_desc":
      rows.sort((a, b) => byNum(b.price_change_pct) - byNum(a.price_change_pct));
      break;
    case "change_asc":
      rows.sort((a, b) => byNum(a.price_change_pct) - byNum(b.price_change_pct));
      break;
    case "symbol_asc":
      rows.sort((a, b) => a.ticker_symbol.localeCompare(b.ticker_symbol));
      break;
    case "impact_desc":
    default:
      rows.sort((a, b) => byNum(b.impact_score) - byNum(a.impact_score));
      break;
  }

  return rows;
}

function renderCards() {
  const rows = getFilteredSortedRows();

  if (rows.length === 0) {
    els.cardGrid.innerHTML = `<p class="empty-state">条件に一致する銘柄がありません。</p>`;
    return;
  }

  els.cardGrid.innerHTML = rows.map((r) => {
    const changeClass = Number(r.price_change_pct) >= 0 ? "positive" : "negative";
    const changeSign = Number(r.price_change_pct) >= 0 ? "+" : "";
    const sentimentClass = r.market_sentiment && SENTIMENT_LABELS[r.market_sentiment] ? r.market_sentiment : "unknown";
    const sentimentLabel = SENTIMENT_LABELS[r.market_sentiment] ?? "分析なし";
    const impactLabel = r.impact_score ? `影響度 ${r.impact_score}/10` : "影響度未評価";

    const ticker = tickerMap.get(r.ticker_symbol);
    const name = displayName(r.ticker_symbol);

    return `
      <article class="stock-card">
        <div class="stock-card-top">
          <div>
            <div class="stock-symbol">${name}<span class="stock-ticker-code">（${r.ticker_symbol}）</span></div>
            ${ticker?.sector_category ? `<span class="sector-badge">${ticker.sector_category}${infoIcon("sector")}</span>` : ""}
          </div>
          <div class="price-block">
            <div class="price">${formatYen(r.current_price)}</div>
            <div class="price-change ${changeClass}">${changeSign}${Number(r.price_change_pct ?? 0).toFixed(2)}%${infoIcon("change")}</div>
          </div>
        </div>
        <div class="badge-row">
          <span class="sentiment-badge ${sentimentClass}">${sentimentLabel}${infoIcon("sentiment")}</span>
          <span class="impact-score">${impactLabel}${infoIcon("impact")}</span>
        </div>
        <div class="fundamentals-grid">
          <span class="fundamental-chip">時価総額 ${formatMarketCap(r.market_cap)}${infoIcon("market_cap")}</span>
          <span class="fundamental-chip">PER ${formatRatio(r.per_ratio, "倍")}${infoIcon("per_ratio")}</span>
          <span class="fundamental-chip">PBR ${formatRatio(r.pbr_ratio, "倍")}${infoIcon("pbr_ratio")}</span>
          <span class="fundamental-chip">ROE ${formatRatio(r.roe, "%")}${infoIcon("roe")}</span>
          <span class="fundamental-chip">配当利回り ${formatRatio(r.dividend_yield, "%")}${infoIcon("dividend_yield")}</span>
        </div>
        ${r.news_summary ? `<div class="news-summary">${r.news_summary}</div>` : `<div class="news-summary">関連ニュースの要約はまだありません。</div>`}
        ${r.news_headline ? `
          <div class="news-headline-original">
            原文: ${r.news_url ? `<a href="${r.news_url}" target="_blank" rel="noopener noreferrer">${r.news_headline}</a>` : r.news_headline}
          </div>
        ` : ""}
        ${r.disclosure_summary ? `
          <div class="news-headline-original">
            適時開示${infoIcon("disclosure")}: ${r.disclosure_url ? `<a href="${r.disclosure_url}" target="_blank" rel="noopener noreferrer">${r.disclosure_summary}</a>` : r.disclosure_summary}
          </div>
        ` : ""}
        <div class="recorded-at">記録日時: ${formatDateTime(r.recorded_at)}</div>
      </article>
    `;
  }).join("");
}

function renderTickerChanges() {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const changes = [];

  for (const t of tickerRows) {
    if (t.added_at && new Date(t.added_at).getTime() >= cutoff) {
      changes.push({ type: "added", symbol: t.ticker_symbol, company: t.company_name, reason: t.added_reason, date: t.added_at });
    }
    if (t.removed_at && new Date(t.removed_at).getTime() >= cutoff) {
      changes.push({ type: "removed", symbol: t.ticker_symbol, company: t.company_name, reason: t.removed_reason, date: t.removed_at });
    }
  }

  changes.sort((a, b) => new Date(b.date) - new Date(a.date));

  if (changes.length === 0) {
    els.tickerChanges.innerHTML = `<p class="empty-state">過去14日以内の採用・除外はありません。</p>`;
    return;
  }

  els.tickerChanges.innerHTML = changes.map((c) => `
    <div class="change-row">
      <span class="change-tag ${c.type}">${c.type === "added" ? "採用" : "除外"}</span>
      <strong>${c.symbol}</strong>
      <span>${c.company}</span>
      <span class="change-reason">${c.reason ?? ""}</span>
      <span class="change-reason">(${formatRelativeDays(c.date)})</span>
    </div>
  `).join("");
}

[els.searchInput, els.sectorFilter, els.sentimentFilter, els.sortSelect].forEach((el) => {
  el.addEventListener("input", renderCards);
  el.addEventListener("change", renderCards);
});

// ---------- タブ切り替え ----------
// Chart.jsは非表示(display:none)のタブ内で初期化されるとcanvasが0サイズのまま固定されるため、
// タブを表示状態にした直後に明示的にresize()して正しいサイズへ再計算させる。
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

    if (btn.dataset.tab === "intraday") intradayChartInstance?.resize();
    if (btn.dataset.tab === "trend") trendChartInstance?.resize();
  });
});

function activeDisplayTickers() {
  return tickerRows
    .filter((t) => t.is_active && t.rank !== null && t.rank <= DISPLAY_RANK_LIMIT)
    .map((t) => ({ symbol: t.ticker_symbol, name: t.company_name }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ---------- 本日の値動き（15分足） ----------
let intradayChartInstance = null;

function populateIntradayTickerSelect() {
  const tickers = activeDisplayTickers();
  const previousValue = els.intradayTickerSelect.value;
  els.intradayTickerSelect.innerHTML = tickers
    .map((t) => `<option value="${t.symbol}">${t.name}（${t.symbol}）</option>`)
    .join("");
  if (previousValue && tickers.some((t) => t.symbol === previousValue)) {
    els.intradayTickerSelect.value = previousValue;
  }
}

async function fetchIntradayHistory(symbol) {
  const todayStartIso = new Date(`${jstDateKey()}T00:00:00+09:00`).toISOString();
  const { data, error } = await client
    .from("jp_stock_intraday_price")
    .select("recorded_at, price")
    .eq("ticker_symbol", symbol)
    .gte("recorded_at", todayStartIso)
    .order("recorded_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function loadIntradayChart() {
  const symbol = els.intradayTickerSelect.value;
  if (!symbol) return;

  let history = [];
  try {
    history = await fetchIntradayHistory(symbol);
  } catch (err) {
    els.intradayEmptyState.style.display = "block";
    els.intradayEmptyState.textContent = `データの取得に失敗しました: ${err.message}`;
    els.intradayChart.style.display = "none";
    return;
  }

  if (history.length === 0) {
    els.intradayEmptyState.style.display = "block";
    els.intradayEmptyState.textContent = "本日のデータがまだありません（休場日、または取引時間外の可能性があります）。";
    els.intradayChart.style.display = "none";
    els.intradayTableBody.innerHTML = "";
    return;
  }

  els.intradayEmptyState.style.display = "none";
  els.intradayChart.style.display = "block";

  const labels = history.map((p) => formatTime(p.recorded_at));
  const prices = history.map((p) => Number(p.price));

  if (intradayChartInstance) {
    intradayChartInstance.destroy();
  }

  intradayChartInstance = new Chart(els.intradayChart, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "株価 (円)",
        data: prices,
        borderColor: "#6c8cff",
        backgroundColor: "rgba(108, 140, 255, 0.15)",
        fill: true,
        tension: 0.25,
        pointRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#e8ecf4" } },
      },
      scales: {
        x: { ticks: { color: "#9aa4b8" }, grid: { color: "#2a3247" } },
        y: { ticks: { color: "#9aa4b8" }, grid: { color: "#2a3247" } },
      },
    },
  });

  els.intradayTableBody.innerHTML = history.slice().reverse().map((p) => `
    <tr>
      <td>${formatTime(p.recorded_at)}</td>
      <td>${formatYen(p.price)}</td>
    </tr>
  `).join("");
}

els.intradayTickerSelect.addEventListener("change", loadIntradayChart);

// ---------- 価格推移（日次・週次・月次・年次） ----------
let trendChartInstance = null;
let currentPeriod = "daily";

function populateTrendTickerSelect() {
  const tickers = activeDisplayTickers();
  const previousValue = els.trendTickerSelect.value;
  els.trendTickerSelect.innerHTML = tickers
    .map((t) => `<option value="${t.symbol}">${t.name}（${t.symbol}）</option>`)
    .join("");
  if (previousValue && tickers.some((t) => t.symbol === previousValue)) {
    els.trendTickerSelect.value = previousValue;
  }
}

// 集計はすべて日本時間（JST）の暦日基準で行う。
// recorded_at はUTCで保存されているため、閲覧者のブラウザのタイムゾーンに関係なく
// 常にJSTの日付として扱う必要がある（さもないと16:30 JST実行分が翌日扱いになる場合がある）。
function jstDateParts(input) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(input));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function startOfWeekJst(input) {
  const { year, month, day } = jstDateParts(input);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  const dow = utcMidnight.getUTCDay();
  const diff = (dow === 0 ? -6 : 1) - dow;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() + diff);
  return utcMidnight.toISOString().slice(0, 10);
}

function periodKey(recordedAt, period) {
  const { year, month } = jstDateParts(recordedAt);
  switch (period) {
    case "weekly":
      return startOfWeekJst(recordedAt);
    case "monthly":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "yearly":
      return `${year}`;
    case "daily":
    default:
      return jstDateKey(recordedAt);
  }
}

function periodLabel(key, period) {
  switch (period) {
    case "weekly":
      return `${key}週`;
    case "monthly": {
      const [y, m] = key.split("-");
      return `${y}年${Number(m)}月`;
    }
    case "yearly":
      return `${key}年`;
    case "daily":
    default: {
      const [, m, d] = key.split("-");
      return `${Number(m)}/${Number(d)}`;
    }
  }
}

const PERIOD_LIMITS = { daily: 60, weekly: 52, monthly: 36, yearly: 15 };

function aggregateByPeriod(history, period) {
  const buckets = new Map();
  for (const row of history) {
    const key = periodKey(row.recorded_at, period);
    const existing = buckets.get(key);
    if (!existing || new Date(row.recorded_at) > new Date(existing.recorded_at)) {
      buckets.set(key, row);
    }
  }
  const sortedKeys = Array.from(buckets.keys()).sort();
  const limit = PERIOD_LIMITS[period] ?? 60;
  const limitedKeys = sortedKeys.slice(-limit);
  return limitedKeys.map((key) => ({ key, ...buckets.get(key) }));
}

async function fetchTickerHistory(symbol) {
  const { data, error } = await client
    .from("jp_stock_intelligence")
    .select("recorded_at, current_price, price_change_pct, market_sentiment")
    .eq("ticker_symbol", symbol)
    .order("recorded_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function loadTrendChart() {
  const symbol = els.trendTickerSelect.value;
  if (!symbol) return;

  let history = [];
  try {
    history = await fetchTickerHistory(symbol);
  } catch (err) {
    els.trendEmptyState.style.display = "block";
    els.trendEmptyState.textContent = `データの取得に失敗しました: ${err.message}`;
    els.trendChart.style.display = "none";
    return;
  }

  if (history.length === 0) {
    els.trendEmptyState.style.display = "block";
    els.trendEmptyState.textContent = "この銘柄のデータがまだありません。";
    els.trendChart.style.display = "none";
    els.trendTableBody.innerHTML = "";
    return;
  }

  const points = aggregateByPeriod(history, currentPeriod);

  els.trendEmptyState.style.display = "none";
  els.trendChart.style.display = "block";

  const labels = points.map((p) => periodLabel(p.key, currentPeriod));
  const prices = points.map((p) => Number(p.current_price));

  if (trendChartInstance) {
    trendChartInstance.destroy();
  }

  trendChartInstance = new Chart(els.trendChart, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "株価 (円)",
        data: prices,
        borderColor: "#6c8cff",
        backgroundColor: "rgba(108, 140, 255, 0.15)",
        fill: true,
        tension: 0.25,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#e8ecf4" } },
      },
      scales: {
        x: { ticks: { color: "#9aa4b8" }, grid: { color: "#2a3247" } },
        y: { ticks: { color: "#9aa4b8" }, grid: { color: "#2a3247" } },
      },
    },
  });

  els.trendTableBody.innerHTML = points.slice().reverse().map((p) => {
    const changeClass = Number(p.price_change_pct) >= 0 ? "positive" : "negative";
    const changeSign = Number(p.price_change_pct) >= 0 ? "+" : "";
    const sentimentLabel = SENTIMENT_LABELS[p.market_sentiment] ?? "-";
    return `
      <tr>
        <td>${periodLabel(p.key, currentPeriod)}</td>
        <td>${formatYen(p.current_price)}</td>
        <td class="price-change ${changeClass}">${changeSign}${Number(p.price_change_pct ?? 0).toFixed(2)}%</td>
        <td>${sentimentLabel}</td>
      </tr>
    `;
  }).join("");
}

els.trendTickerSelect.addEventListener("change", loadTrendChart);

els.periodToggle.querySelectorAll(".period-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    els.periodToggle.querySelectorAll(".period-button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPeriod = btn.dataset.period;
    loadTrendChart();
  });
});

loadData();
