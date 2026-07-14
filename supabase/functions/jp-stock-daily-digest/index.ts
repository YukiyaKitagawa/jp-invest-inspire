// 日次ニュース・センチメント分析: 16:30 JST(大引け後、材料が出揃ってから)に実行。
// 終値は別途EOD取得せず、当日のjp_stock_intraday_price最終値を採用する。
// Google Newsを主材料、TDnet適時開示を補強材料としてGeminiで要約・センチメント・影響度を判定する。
//
// Geminiは銘柄ごとに1回ずつ呼ぶとレート制限にかかりやすいため、BATCH_SIZE件ずつまとめて
// 1回のプロンプトで処理する（例: 45銘柄なら5回程度の呼び出しに収まる）。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { isTradingDay, jstDateKey } from "../_shared/marketCalendar.ts";
import { fetchFundamentalMetrics } from "../_shared/yahooFinance.ts";
import { fetchNewsForCompany } from "../_shared/googleNews.ts";
import { fetchTodayDisclosures } from "../_shared/tdnet.ts";
import { analyzeCompanyBatch, type AnalysisResult, type CompanyInput } from "../_shared/gemini.ts";

const FETCH_CONCURRENCY = 5;
// Gemini無料枠は5リクエスト/分と厳しいため、バッチを大きめにして呼び出し回数を抑え、
// かつ並列実行はせず直列(concurrency=1)で回す。個々の呼び出しは429時に内部リトライする。
const GEMINI_BATCH_SIZE = 15;
const GEMINI_BATCH_CONCURRENCY = 1;

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

Deno.serve(async () => {
  try {
    const client = createServiceClient();

    if (!(await isTradingDay(client))) {
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

    // フェーズ1: 株価指標・ニュース・適時開示の収集（Gemini以外、レート制限の心配が少ない）
    const fetched = await mapWithConcurrency(tickers, FETCH_CONCURRENCY, async (ticker) => {
      const [fundamentals, news, disclosures] = await Promise.all([
        fetchFundamentalMetrics(ticker.ticker_symbol),
        fetchNewsForCompany(ticker.company_name),
        fetchTodayDisclosures(ticker.ticker_symbol),
      ]);
      return { ticker, fundamentals, news, disclosures };
    });

    // フェーズ2: GeminiはGEMINI_BATCH_SIZE件ずつまとめて呼び出し、呼び出し回数を抑える
    const companyInputs: CompanyInput[] = fetched.map((f) => ({
      tickerSymbol: f.ticker.ticker_symbol,
      companyName: f.ticker.company_name,
      news: f.news,
      disclosures: f.disclosures,
    }));

    const batches = chunk(companyInputs, GEMINI_BATCH_SIZE);
    const batchResults = await mapWithConcurrency(batches, GEMINI_BATCH_CONCURRENCY, async (b) => {
      try {
        return await analyzeCompanyBatch(b);
      } catch (err) {
        // レート制限等で失敗した場合、このバッチの銘柄は market_sentiment が NULL のまま保存され、
        // 後続の jp-stock-reanalyze-pending が拾って再試行する。日次分析全体は失敗させない。
        console.error("Gemini batch failed, will retry later via jp-stock-reanalyze-pending:", err);
        return new Map<string, AnalysisResult>();
      }
    });
    const analysisMap = new Map<string, AnalysisResult>();
    for (const m of batchResults) for (const [symbol, result] of m) analysisMap.set(symbol, result);

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
        per_ratio: fundamentals.perRatio,
        pbr_ratio: fundamentals.pbrRatio,
        dividend_yield: fundamentals.dividendYield,
        market_cap: fundamentals.marketCap,
        roe: fundamentals.roe,
        market_sentiment: analysis?.sentiment ?? null,
        impact_score: analysis?.impactScore ?? null,
        news_summary: analysis?.summary ?? null,
        news_headline: analysis?.headline ?? null,
        news_url: analysis?.url ?? null,
        disclosure_summary: analysis?.disclosureSummary ?? null,
        disclosure_url: analysis?.disclosureUrl ?? null,
      };
    });

    const { error: insertError } = await client.from("jp_stock_intelligence").insert(rows);
    if (insertError) throw insertError;

    return new Response(
      JSON.stringify({ ok: true, processed: rows.length, geminiCalls: batches.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
