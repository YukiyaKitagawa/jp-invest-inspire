// 日次ニュース・センチメント分析: 16:30 JST(大引け後、材料が出揃ってから)に実行。
// 終値は別途EOD取得せず、当日のjp_stock_intraday_price最終値を採用する。
// Google Newsを主材料、TDnet適時開示を補強材料としてGeminiで要約・センチメント・影響度を判定する。
//
// - Geminiは BATCH_SIZE 件ずつまとめて1回のプロンプトで処理し、モデルは優先順リストで自動切替する。
// - ニュース取得に失敗した銘柄は「記事なし」にせず分析待ち(market_sentiment=NULL)のまま保存し、
//   jp-stock-reanalyze-pending が後で再試行する。
// - Edge Functionの実行上限(約150秒)を超えないよう、フェーズごとに時間予算を設ける。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { isTradingDay, jstDateKey } from "../_shared/marketCalendar.ts";
import { fetchFundamentalMetrics } from "../_shared/yahooFinance.ts";
import { fetchNews, type NewsResult } from "../_shared/googleNews.ts";
import { fetchTodayDisclosures } from "../_shared/tdnet.ts";
import { analyzeCompanyBatch, type AnalysisResult, type CompanyInput } from "../_shared/gemini.ts";

const FETCH_CONCURRENCY = 3;
const GEMINI_BATCH_SIZE = 15;

const FETCH_BUDGET_MS = 60_000; // 記事・指標の収集フェーズ
const TOTAL_BUDGET_MS = 130_000; // Gemini分析を含む全体（上限150秒に対する余裕）

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const client = createServiceClient();

    // ?dryRun=1: 休場日チェックを無視してDBへは書き込まず、収集・分析の結果だけを返す（動作確認用）
    const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

    if (!dryRun && !(await isTradingDay(client))) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: tickers, error: tickerError } = await client
      .from("jp_stock_tickers")
      .select("ticker_symbol, company_name")
      .eq("is_active", true);
    if (tickerError) throw tickerError;
    if (!tickers || tickers.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const symbols = tickers.map((t) => t.ticker_symbol);

    const { data: previousRows, error: prevError } = await client
      .from("jp_stock_intelligence_latest")
      .select("ticker_symbol, current_price")
      .in("ticker_symbol", symbols);
    if (prevError) throw prevError;
    const previousPriceMap = new Map((previousRows ?? []).map((r) => [r.ticker_symbol, r.current_price]));

    const todayStartIso = new Date(`${jstDateKey()}T00:00:00+09:00`).toISOString();
    const { data: intradayRows, error: intradayError } = await client
      .from("jp_stock_intraday_price")
      .select("ticker_symbol, price, recorded_at")
      .in("ticker_symbol", symbols)
      .gte("recorded_at", todayStartIso)
      .order("recorded_at", { ascending: true });
    if (intradayError) throw intradayError;

    const latestPriceMap = new Map<string, number>();
    for (const row of intradayRows ?? []) {
      latestPriceMap.set(row.ticker_symbol, row.price); // 昇順なので最後に上書きされた値が最新
    }

    // フェーズ1: 株価指標・ニュース・適時開示の収集（時間予算を超えたら残りは失敗扱いにして先へ進む）
    const fetchDeadline = startedAt + FETCH_BUDGET_MS;
    const skipped: NewsResult = { ok: false, items: [], error: "skipped: fetch budget exceeded" };

    const fetched = await mapWithConcurrency(tickers, FETCH_CONCURRENCY, async (ticker) => {
      if (Date.now() > fetchDeadline) {
        return { ticker, fundamentals: null, news: skipped, disclosures: [] };
      }
      const [fundamentals, news, disclosures] = await Promise.all([
        fetchFundamentalMetrics(ticker.ticker_symbol),
        fetchNews(ticker.company_name),
        fetchTodayDisclosures(ticker.ticker_symbol),
      ]);
      return { ticker, fundamentals, news, disclosures };
    });

    const newsFailedCount = fetched.filter((f) => !f.news.ok).length;
    console.log(
      `[jp-stock-daily-digest] fetch phase done in ${Date.now() - startedAt}ms: ` +
        `news failed ${newsFailedCount}/${fetched.length}`,
    );

    // フェーズ2: GeminiはGEMINI_BATCH_SIZE件ずつ直列で呼ぶ。1バッチの失敗で全体を止めない。
    const companyInputs: CompanyInput[] = fetched.map((f) => ({
      tickerSymbol: f.ticker.ticker_symbol,
      companyName: f.ticker.company_name,
      news: f.news.items,
      newsFailed: !f.news.ok,
      disclosures: f.disclosures,
    }));

    const batches = chunk(companyInputs, GEMINI_BATCH_SIZE);
    const analysisMap = new Map<string, AnalysisResult>();
    const batchErrors: string[] = [];
    const totalDeadline = startedAt + TOTAL_BUDGET_MS;
    for (const batch of batches) {
      try {
        for (const [symbol, result] of await analyzeCompanyBatch(batch, totalDeadline)) {
          analysisMap.set(symbol, result);
        }
      } catch (err) {
        // 失敗したバッチの銘柄は分析待ちのまま保存され、jp-stock-reanalyze-pending が後で拾う
        console.error("Gemini batch failed, rows stay pending for retry:", err);
        batchErrors.push(String(err).slice(0, 300));
      }
    }

    const recordedAt = new Date().toISOString();

    const rows = fetched.map(({ ticker, fundamentals }) => {
      const currentPrice = latestPriceMap.get(ticker.ticker_symbol) ?? null;
      const previousPrice = previousPriceMap.get(ticker.ticker_symbol) ?? null;
      const priceChangePct =
        currentPrice !== null && previousPrice !== null && previousPrice !== 0
          ? ((currentPrice - previousPrice) / previousPrice) * 100
          : null;
      const analysis = analysisMap.get(ticker.ticker_symbol);

      return {
        ticker_symbol: ticker.ticker_symbol,
        recorded_at: recordedAt,
        current_price: currentPrice,
        price_change_pct: priceChangePct,
        per_ratio: fundamentals?.perRatio ?? null,
        pbr_ratio: fundamentals?.pbrRatio ?? null,
        dividend_yield: fundamentals?.dividendYield ?? null,
        market_cap: fundamentals?.marketCap ?? null,
        roe: fundamentals?.roe ?? null,
        market_sentiment: analysis?.sentiment ?? null,
        impact_score: analysis?.impactScore ?? null,
        news_summary: analysis?.summary ?? null,
        news_headline: analysis?.headline ?? null,
        news_url: analysis?.url ?? null,
        disclosure_summary: analysis?.disclosureSummary ?? null,
        disclosure_url: analysis?.disclosureUrl ?? null,
        analysis_model: analysis?.model ?? null,
      };
    });

    if (!dryRun) {
      const { error: insertError } = await client.from("jp_stock_intelligence").insert(rows);
      if (insertError) throw insertError;
    }

    const pending = rows.filter((r) => r.market_sentiment === null).length;
    const models = [...new Set(rows.map((r) => r.analysis_model).filter((m): m is string => m !== null))];
    console.log(
      `[jp-stock-daily-digest] done in ${Date.now() - startedAt}ms: ` +
        `processed ${rows.length}, pending ${pending}, models ${models.join(",") || "-"}`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        dryRun,
        processed: rows.length,
        newsFailed: newsFailedCount,
        pending,
        geminiBatches: batches.length,
        models,
        batchErrors: batchErrors.slice(0, 2),
        elapsedMs: Date.now() - startedAt,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(`[jp-stock-daily-digest] fatal: ${String(err)}`);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
