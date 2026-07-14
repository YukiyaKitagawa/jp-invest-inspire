// 分析待ち銘柄の再試行: jp-stock-daily-digest実行時にGeminiがレート制限等で失敗し、
// market_sentimentがNULLのまま保存された本日分の行を見つけて、ニュース・開示を再取得し
// Geminiで再分析、既存行をUPDATEする。日次分析の一定時間後に実行する想定。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { jstDateKey } from "../_shared/marketCalendar.ts";
import { fetchNewsForCompany } from "../_shared/googleNews.ts";
import { fetchTodayDisclosures } from "../_shared/tdnet.ts";
import { analyzeCompanyBatch, type AnalysisResult, type CompanyInput } from "../_shared/gemini.ts";

const FETCH_CONCURRENCY = 5;
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

    const todayStartIso = new Date(`${jstDateKey()}T00:00:00+09:00`).toISOString();
    const { data: pendingRows, error: pendingError } = await client
      .from("jp_stock_intelligence")
      .select("id, ticker_symbol, jp_stock_tickers(company_name)")
      .is("market_sentiment", null)
      .gte("recorded_at", todayStartIso);
    if (pendingError) throw pendingError;
    if (!pendingRows || pendingRows.length === 0) {
      return new Response(JSON.stringify({ ok: true, pending: 0, retried: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const fetched = await mapWithConcurrency(pendingRows, FETCH_CONCURRENCY, async (row) => {
      const companyName = (row as unknown as { jp_stock_tickers: { company_name: string } }).jp_stock_tickers
        .company_name;
      const [news, disclosures] = await Promise.all([
        fetchNewsForCompany(companyName),
        fetchTodayDisclosures(row.ticker_symbol),
      ]);
      return { id: row.id, tickerSymbol: row.ticker_symbol, companyName, news, disclosures };
    });

    const companyInputs: CompanyInput[] = fetched.map((f) => ({
      tickerSymbol: f.tickerSymbol,
      companyName: f.companyName,
      news: f.news,
      disclosures: f.disclosures,
    }));

    const batchErrors: string[] = [];
    const batches = chunk(companyInputs, GEMINI_BATCH_SIZE);
    const batchResults = await mapWithConcurrency(batches, GEMINI_BATCH_CONCURRENCY, async (b) => {
      try {
        return await analyzeCompanyBatch(b);
      } catch (err) {
        console.error("Gemini batch failed again, will remain pending:", err);
        batchErrors.push(String(err));
        return new Map<string, AnalysisResult>();
      }
    });
    const analysisMap = new Map<string, AnalysisResult>();
    for (const m of batchResults) for (const [symbol, result] of m) analysisMap.set(symbol, result);

    let retried = 0;
    for (const f of fetched) {
      const analysis = analysisMap.get(f.tickerSymbol);
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
        })
        .eq("id", f.id);
      if (updateError) throw updateError;
      retried++;
    }

    return new Response(
      JSON.stringify({ ok: true, pending: pendingRows.length, retried, batchErrorCount: batchErrors.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
