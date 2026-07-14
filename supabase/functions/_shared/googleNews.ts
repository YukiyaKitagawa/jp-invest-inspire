// Google Newsの日本語検索RSSから、企業名+テーマキーワードでニュースを取得する。

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

const THEME_KEYWORDS = ["AI", "半導体", "生成AI", "GPU", "データセンター", "ファウンドリ"];

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "s"));
  return match ? match[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, "$1").trim() : "";
}

// 過去7日間のGoogle Newsヒット件数を露出量スコアとして返す（週次選定ロジック用）。
export async function fetchExposureScore(companyName: string): Promise<number> {
  const items = await fetchNewsForCompany(companyName, 100);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const t = Date.parse(item.pubDate);
    return !isNaN(t) && t >= cutoff;
  }).length;
}

export async function fetchNewsForCompany(companyName: string, maxItems = 5): Promise<NewsItem[]> {
  const query = encodeURIComponent(`${companyName} (${THEME_KEYWORDS.join(" OR ")})`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=ja&gl=JP&ceid=JP:ja`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; jp-stock-dashboard/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const items = xml.split("<item>").slice(1).slice(0, maxItems);
    return items.map((chunk) => ({
      title: extractTag(chunk, "title"),
      link: extractTag(chunk, "link"),
      pubDate: extractTag(chunk, "pubDate"),
      source: extractTag(chunk, "source"),
    })).filter((item) => item.title);
  } catch (err) {
    console.error(`fetchNewsForCompany failed for ${companyName}:`, err);
    return [];
  }
}
