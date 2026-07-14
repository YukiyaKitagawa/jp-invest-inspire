// 週次銘柄選定ローテーション。
// jp_stock_tickers に登録済みの候補プール全件をGoogle News露出量でスコアリングし、
// 上位50位を収集対象(is_active)とする。除外は3週連続でスコア圏外(rank>50)の場合のみ。
//
// 注意: このジョブは「候補プールの中で」ランキングを更新するだけで、プール自体に
// 新しい銘柄を自動発掘・追加する機能は持たない（候補プールは jp_stock_tickers に
// 手動 or シードSQLで登録した銘柄が母集団になる）。将来的に候補プールを広げたい場合は
// jp_stock_tickers に新しい行を追加すること。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { fetchExposureScore } from "../_shared/googleNews.ts";

const COLLECTION_LIMIT = 50;
const REMOVAL_GRACE_WEEKS = 3;
const CONCURRENCY = 5;

interface TickerRow {
  ticker_symbol: string;
  company_name: string;
  is_active: boolean;
  consecutive_low_weeks: number;
}

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

    const { data: tickers, error: tickerError } = await client
      .from("jp_stock_tickers")
      .select("ticker_symbol, company_name, is_active, consecutive_low_weeks");
    if (tickerError) throw tickerError;
    if (!tickers || tickers.length === 0) {
      return new Response(JSON.stringify({ ok: true, reviewed: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const scores = await mapWithConcurrency(tickers as TickerRow[], CONCURRENCY, async (t) => ({
      ticker_symbol: t.ticker_symbol,
      score: await fetchExposureScore(t.company_name),
    }));
    const scoreMap = new Map(scores.map((s) => [s.ticker_symbol, s.score]));

    const ranked = [...tickers as TickerRow[]].sort(
      (a, b) => (scoreMap.get(b.ticker_symbol) ?? 0) - (scoreMap.get(a.ticker_symbol) ?? 0),
    );

    const now = new Date().toISOString();
    const updates = ranked.map((t, index) => {
      const rank = index + 1;
      const exposureScore = scoreMap.get(t.ticker_symbol) ?? 0;
      const withinLimit = rank <= COLLECTION_LIMIT;

      let isActive = t.is_active;
      let consecutiveLowWeeks = t.consecutive_low_weeks;
      let addedAt: string | undefined;
      let addedReason: string | undefined;
      let removedAt: string | undefined;
      let removedReason: string | undefined;

      if (withinLimit) {
        consecutiveLowWeeks = 0;
        if (!t.is_active) {
          isActive = true;
          addedAt = now;
          addedReason = `露出量スコア上位${COLLECTION_LIMIT}入り（score=${exposureScore}）`;
        }
      } else if (t.is_active) {
        consecutiveLowWeeks = t.consecutive_low_weeks + 1;
        if (consecutiveLowWeeks >= REMOVAL_GRACE_WEEKS) {
          isActive = false;
          consecutiveLowWeeks = 0;
          removedAt = now;
          removedReason = `${REMOVAL_GRACE_WEEKS}週連続で上位${COLLECTION_LIMIT}圏外`;
        }
      }

      return {
        ticker_symbol: t.ticker_symbol,
        exposure_score: exposureScore,
        rank,
        is_active: isActive,
        consecutive_low_weeks: consecutiveLowWeeks,
        ...(addedAt ? { added_at: addedAt, added_reason: addedReason } : {}),
        ...(removedAt ? { removed_at: removedAt, removed_reason: removedReason } : {}),
      };
    });

    for (const update of updates) {
      const { ticker_symbol, ...fields } = update;
      const { error } = await client.from("jp_stock_tickers").update(fields).eq("ticker_symbol", ticker_symbol);
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        reviewed: updates.length,
        active: updates.filter((u) => u.is_active).length,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
