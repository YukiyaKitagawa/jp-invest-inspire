// yfinanceが内部で利用しているのと同じYahoo Finance公開エンドポイントを直接叩くラッパー。
// 認証不要・無料だが非公式のため、失敗時は呼び出し側でリトライ/欠損許容すること。

const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const QUOTE_SUMMARY_BASE = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";

function toYahooSymbol(tickerSymbol: string): string {
  return `${tickerSymbol}.T`;
}

export interface LatestQuote {
  tickerSymbol: string;
  price: number | null;
  previousClose: number | null;
}

// 複数銘柄の「直近1本の価格」をまとめて取得する。
// chart APIは1リクエスト1銘柄だが、Promise.allで並列化しレート制限を避けるため
// 呼び出し側で15分間隔のバッチ実行1回にまとめる想定。
export async function fetchLatestQuotes(tickerSymbols: string[]): Promise<LatestQuote[]> {
  const results = await Promise.all(
    tickerSymbols.map(async (tickerSymbol): Promise<LatestQuote> => {
      try {
        const symbol = toYahooSymbol(tickerSymbol);
        const url = `${CHART_BASE}/${symbol}?interval=1m&range=1d`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; jp-stock-dashboard/1.0)" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        const meta = result?.meta;
        return {
          tickerSymbol,
          price: meta?.regularMarketPrice ?? null,
          previousClose: meta?.previousClose ?? meta?.chartPreviousClose ?? null,
        };
      } catch (err) {
        console.error(`fetchLatestQuotes failed for ${tickerSymbol}:`, err);
        return { tickerSymbol, price: null, previousClose: null };
      }
    }),
  );
  return results;
}

export interface FundamentalMetrics {
  tickerSymbol: string;
  perRatio: number | null;
  pbrRatio: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  roe: number | null;
}

export async function fetchFundamentalMetrics(tickerSymbol: string): Promise<FundamentalMetrics> {
  const empty: FundamentalMetrics = {
    tickerSymbol,
    perRatio: null,
    pbrRatio: null,
    dividendYield: null,
    marketCap: null,
    roe: null,
  };
  try {
    const symbol = toYahooSymbol(tickerSymbol);
    const modules = "defaultKeyStatistics,summaryDetail,financialData";
    const url = `${QUOTE_SUMMARY_BASE}/${symbol}?modules=${modules}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; jp-stock-dashboard/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.quoteSummary?.result?.[0];
    const keyStats = result?.defaultKeyStatistics;
    const summary = result?.summaryDetail;
    const financial = result?.financialData;

    return {
      tickerSymbol,
      perRatio: summary?.trailingPE?.raw ?? null,
      pbrRatio: keyStats?.priceToBook?.raw ?? null,
      dividendYield: summary?.dividendYield?.raw != null ? summary.dividendYield.raw * 100 : null,
      marketCap: summary?.marketCap?.raw ?? null,
      roe: financial?.returnOnEquity?.raw != null ? financial.returnOnEquity.raw * 100 : null,
    };
  } catch (err) {
    console.error(`fetchFundamentalMetrics failed for ${tickerSymbol}:`, err);
    return empty;
  }
}
