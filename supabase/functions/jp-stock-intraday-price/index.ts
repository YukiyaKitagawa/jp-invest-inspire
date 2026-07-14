// 15分足株価収集: 取引時間中(9:00-11:30,12:30-15:00 JST)のみ、収集対象銘柄(上位50/is_active)を
// まとめて1回のバッチでYahoo Financeから取得し jp_stock_intraday_price に記録する。
// cronは15分おきに常時起動される想定で、非営業日・時間外はここで判定してスキップする。
import { createServiceClient } from "../_shared/supabaseClient.ts";
import { isTradingDay, isWithinTradingHours } from "../_shared/marketCalendar.ts";
import { fetchLatestQuotes } from "../_shared/yahooFinance.ts";

Deno.serve(async () => {
  try {
    const client = createServiceClient();

    if (!(await isTradingDay(client)) || !isWithinTradingHours()) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: tickers, error: tickerError } = await client
      .from("jp_stock_tickers")
      .select("ticker_symbol")
      .eq("is_active", true);
    if (tickerError) throw tickerError;
    if (!tickers || tickers.length === 0) {
      return new Response(JSON.stringify({ ok: true, collected: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const quotes = await fetchLatestQuotes(tickers.map((t) => t.ticker_symbol));
    const recordedAt = new Date().toISOString();
    const rows = quotes
      .filter((q) => q.price !== null)
      .map((q) => ({ ticker_symbol: q.tickerSymbol, price: q.price, recorded_at: recordedAt }));

    if (rows.length > 0) {
      const { error: insertError } = await client.from("jp_stock_intraday_price").insert(rows);
      if (insertError) throw insertError;
    }

    return new Response(
      JSON.stringify({ ok: true, collected: rows.length, failed: quotes.length - rows.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
