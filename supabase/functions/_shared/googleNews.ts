// Google Newsの日本語検索RSSから、企業名+テーマキーワードでニュースを取得する。
//
// Google NewsはデータセンターIPからのアクセスに対して断続的にHTTP 503を返すことがある。
// 「取得失敗」と「該当記事なし」を区別できるよう、結果に ok フラグを持たせる。
// 失敗を空配列として扱うと、記事なし(中立判定)や露出量スコア0として誤って記録されてしまうため。

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

export interface NewsResult {
  ok: boolean; // false = 取得失敗（ブロック・タイムアウト等）。items=[] でも ok=true なら「記事なし」
  items: NewsItem[];
  error?: string;
}

const THEME_KEYWORDS = ["AI", "半導体", "生成AI", "GPU", "データセンター", "ファウンドリ"];

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * (baseMs / 2));
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "s"));
  return match ? match[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, "$1").trim() : "";
}

async function fetchRss(url: string): Promise<string> {
  let lastError: unknown = new Error("unknown");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let retryable = true;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; jp-stock-dashboard/1.0)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) return await res.text();
      retryable = RETRYABLE_STATUS.has(res.status);
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err; // タイムアウト・ネットワークエラーは再試行対象
    }
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    await sleep(withJitter(1500 * attempt));
  }
  throw lastError;
}

export async function fetchNews(companyName: string, maxItems = 5): Promise<NewsResult> {
  const query = encodeURIComponent(`${companyName} (${THEME_KEYWORDS.join(" OR ")})`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=ja&gl=JP&ceid=JP:ja`;

  try {
    await sleep(withJitter(200)); // 連続リクエストの間隔を少しばらけさせる
    const xml = await fetchRss(url);

    // 200でもRSSではない応答（同意画面・ブロックページ等）は失敗として扱う
    if (!xml.includes("<rss") && !xml.includes("<channel")) {
      throw new Error("unexpected response (not RSS)");
    }

    const items = xml.split("<item>").slice(1).slice(0, maxItems);
    return {
      ok: true,
      items: items.map((chunk) => ({
        title: extractTag(chunk, "title"),
        link: extractTag(chunk, "link"),
        pubDate: extractTag(chunk, "pubDate"),
        source: extractTag(chunk, "source"),
      })).filter((item) => item.title),
    };
  } catch (err) {
    console.error(`fetchNews failed for ${companyName}: ${String(err)}`);
    return { ok: false, items: [], error: String(err) };
  }
}

// 過去7日間のGoogle Newsヒット件数を露出量スコアとして返す（週次選定ロジック用）。
// 取得に失敗した場合は null を返し、呼び出し側でスコア0と区別できるようにする。
export async function fetchExposureScore(companyName: string): Promise<number | null> {
  const result = await fetchNews(companyName, 100);
  if (!result.ok) return null;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return result.items.filter((item) => {
    const t = Date.parse(item.pubDate);
    return !isNaN(t) && t >= cutoff;
  }).length;
}
