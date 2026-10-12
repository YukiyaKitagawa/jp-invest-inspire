// 分析待ち銘柄の再試行: jp-stock-daily-digest でニュース取得やGeminiが失敗し、
// market_sentimentがNULLのまま保存された行を見つけて、ニュース・開示を再取得し再分析して既存行をUPDATEする。
//
// 対象は直近 LOOKBACK_DAYS 日分。ニュース取得元(Google News)の一時的なブロックは数日続くことがあり、
// 当日分だけを見ていると日をまたいで永久に未分析のまま残ってしまうため。
// 日をまたいだ行には「再試行時点の最新ニュース」で分析が入る点に注意（過去日の記事を厳密には再現しない）。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { jstDateKey } from "../_shared/marketCalendar.ts";
import { fetchNews, type NewsResult } from "../_shared/googleNews.ts";
import { fetchTodayDisclosures } from "../_shared/tdnet.ts";
import { analyzeCompanyBatch, type AnalysisResult, type CompanyInput } from "../_shared/gemini.ts";

const LOOKBACK_DAYS = 3;
const FETCH_CONCURRENCY = 3;
const GEMINI_BATCH_SIZE = 15;
const FETCH_BUDGET_MS = 60_000;
const TOTAL_BUDGET_MS = 130_000;

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

    // 手動での補完用に ?days=N（1〜14）で遡り日数を変えられる。cronは指定なし(既定LOOKBACK_DAYS)
    const daysParam = Number(new URL(req.url).searchParams.get("days"));
    const lookbackDays = Number.isInteger(daysParam) && daysParam >= 1 && daysParam <= 14 ? daysParam : LOOKBACK_DAYS;

    const sinceIso = new Date(
      new Date(`${jstDateKey()}T00:00:00+09:00`).getTime() - (lookbackDays - 1) * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: pendingRows, error: pendingError } = await client
      .from("jp_stock_intelligence")
      .select("id, ticker_symbol, jp_stock_tickers(company_name)")
      .is("market_sentiment", null)
      .gte("recorded_at", sinceIso);
    if (pendingError) throw pendingError;
    if (!pendingRows || pendingRows.length === 0) {
      return new Response(JSON.stringify({ ok: true, pending: 0, retried: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 同じ銘柄が複数日分たまっている場合は、取得・分析は銘柄ごとに1回だけ行い、全ての行に反映する
    const rowIdsBySymbol = new Map<string, string[]>();
    const companyNameBySymbol = new Map<string, string>();
    for (const row of pendingRows) {
      const name = (row as unknown as { jp_stock_tickers: { company_name: string } }).jp_stock_tickers.company_name;
      companyNameBySymbol.set(row.ticker_symbol, name);
      rowIdsBySymbol.set(row.ticker_symbol, [...(rowIdsBySymbol.get(row.ticker_symbol) ?? []), row.id]);
    }
    const symbols = [...rowIdsBySymbol.keys()];

    const fetchDeadline = startedAt + FETCH_BUDGET_MS;
    const skipped: NewsResult = { ok: false, items: [], error: "skipped: fetch budget exceeded" };

    const fetched = await mapWithConcurrency(symbols, FETCH_CONCURRENCY, async (symbol) => {
      if (Date.now() > fetchDeadline) {
        return { symbol, news: skipped, disclosures: [] };
      }
      const companyName = companyNameBySymbol.get(symbol)!;
      const [news, disclosures] = await Promise.all([fetchNews(companyName), fetchTodayDisclosures(symbol)]);
      return { symbol, news, disclosures };
    });

    const newsFailedCount = fetched.filter((f) => !f.news.ok).length;

    const companyInputs: CompanyInput[] = fetched.map((f) => ({
      tickerSymbol: f.symbol,
      companyName: companyNameBySymbol.get(f.symbol)!,
      news: f.news.items,
      newsFailed: !f.news.ok,
      disclosures: f.disclosures,
    }));

    const analysisMap = new Map<string, AnalysisResult>();
    const batchErrors: string[] = [];
    const totalDeadline = startedAt + TOTAL_BUDGET_MS;
    for (const batch of chunk(companyInputs, GEMINI_BATCH_SIZE)) {
      try {
        for (const [symbol, result] of await analyzeCompanyBatch(batch, totalDeadline)) {
          analysisMap.set(symbol, result);
        }
      } catch (err) {
        console.error("Gemini batch failed again, rows remain pending:", err);
        batchErrors.push(String(err).slice(0, 300));
      }
    }

    let retriedRows = 0;
    for (const [symbol, rowIds] of rowIdsBySymbol) {
      const analysis = analysisMap.get(symbol);
      if (!analysis) continue; // 今回も失敗。次回のスケジュール実行に持ち越す

      const { error: updateError } = await client
        .from("jp_stock_intelligence")
        .update({
          market_sentiment: analysis.sentiment,
          impact_score: analysis.impactScore,
          news_summary: analysis.summary,
          news_headline: analysis.headline,
          news_url: analysis.url,
          disclosure_summary: analysis.disclosureSummary,
          disclosure_url: analysis.disclosureUrl,
          analysis_model: analysis.model,
        })
        .in("id", rowIds);
      if (updateError) throw updateError;
      retriedRows += rowIds.length;
    }

    console.log(
      `[jp-stock-reanalyze-pending] done in ${Date.now() - startedAt}ms: ` +
        `pending rows ${pendingRows.length}, recovered ${retriedRows}, news failed ${newsFailedCount}/${symbols.length}`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        pending: pendingRows.length,
        retried: retriedRows,
        newsFailed: newsFailedCount,
        batchErrors: batchErrors.slice(0, 2),
        elapsedMs: Date.now() - startedAt,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(`[jp-stock-reanalyze-pending] fatal: ${String(err)}`);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
