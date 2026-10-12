// TDnet適時開示の取得。
// TDnet自体は公式JSON APIを提供していないため、非公式ミラー(yanoshin氏提供)の
// JSON API経由で取得する。停止・仕様変更のリスクがあるため、失敗時は空配列を返し
// 日次分析全体は継続できるようにする（Google Newsを主材料、TDnetは補強材料の位置づけ）。
import { jstDateKey } from "./marketCalendar.ts";

export interface Disclosure {
  title: string;
  url: string;
  publishedAt: string;
}

export async function fetchTodayDisclosures(tickerSymbol: string): Promise<Disclosure[]> {
  const url = `https://webapi.yanoshin.jp/webapi/tdnet/list/${tickerSymbol}/20.json`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; jp-stock-dashboard/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.items ?? [];
    const today = jstDateKey();

    return items
      .map((entry: { Tdnet: { title: string; document_url: string; pubdate: string } }) => entry.Tdnet)
      .filter((d: { pubdate: string }) => d.pubdate?.startsWith(today))
      .map((d: { title: string; document_url: string; pubdate: string }) => ({
        title: d.title,
        url: d.document_url,
        publishedAt: d.pubdate,
      }));
  } catch (err) {
    console.error(`fetchTodayDisclosures failed for ${tickerSymbol}:`, err);
    return [];
  }
}
