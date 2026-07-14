// 日次ニュース・センチメント分析: 16:30 JST(大引け後、材料が出揃ってから)に実行。
// 終値は別途EOD取得せず、当日のjp_stock_intraday_price最終値を採用する。
// Google Newsを主材料、TDnet適時開示を補強材料としてGeminiで要約・センチメント・影響度を判定する。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { isTradingDay, jstDateKey } from "../_shared/marketCalendar.ts";
import { fetchFundamentalMetrics } from "../_shared/yahooFinance.ts";
import { fetchNewsForCompany } from "../_shared/googleNews.ts";
import { fetchTodayDisclosures } from "../_shared/tdnet.ts";
import { analyzeCompanyNews } from "../_shared/gemini.ts";

const CONCURRENCY = 5;

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

    const recordedAt = new Date().toISOString();

    const rows = await mapWithConcurrency(tickers, CONCURRENCY, async (ticker) => {
      const currentPrice = latestPriceMap.get(ticker.ticker_symbol) ?? null;
      const previousPrice = previousPriceMap.get(ticker.ticker_symbol) ?? null;
      const priceChangePct =
        currentPrice !== null && previousPrice !== null && previousPrice !== 0
          ? ((currentPrice - previousPrice) / previousPrice) * 100
          : null;

      const [fundamentals, news, disclosures] = await Promise.all([
        fetchFundamentalMetrics(ticker.ticker_symbol),
        fetchNewsForCompany(ticker.company_name),
        fetchTodayDisclosures(ticker.ticker_symbol),
      ]);

      const analysis = await analyzeCompanyNews(ticker.company_name, news, disclosures);

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
        market_sentiment: analysis.sentiment,
        impact_score: analysis.impactScore,
        news_summary: analysis.summary,
        news_headline: analysis.headline,
        news_url: analysis.url,
        disclosure_summary: analysis.disclosureSummary,
        disclosure_url: analysis.disclosureUrl,
      };
    });

    const { error: insertError } = await client.from("jp_stock_intelligence").insert(rows);
    if (insertError) throw insertError;

    return new Response(JSON.stringify({ ok: true, processed: rows.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
