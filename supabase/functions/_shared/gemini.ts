// Geminiによるニュース要約・センチメント判定・影響度スコアリング。
// 銘柄ごとに1回ずつ呼ぶとレート制限にかかりやすいため、複数銘柄をまとめて1回のプロンプトで
// 処理するバッチ方式にしている（analyzeCompanyBatch）。
// URLはLLMの出力をそのまま信用せず、こちらが渡したニュース一覧のindexで参照させることで
// リンク先のハルシネーションを防ぐ。
import type { NewsItem } from "./googleNews.ts";
import type { Disclosure } from "./tdnet.ts";

const MODEL = "gemini-2.5-flash-lite";

export interface AnalysisResult {
  summary: string | null;
  headline: string | null;
  url: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  impactScore: number | null;
  disclosureSummary: string | null;
  disclosureUrl: string | null;
}

const EMPTY_RESULT: AnalysisResult = {
  summary: null,
  headline: null,
  url: null,
  sentiment: null,
  impactScore: null,
  disclosureSummary: null,
  disclosureUrl: null,
};

export interface CompanyInput {
  tickerSymbol: string;
  companyName: string;
  news: NewsItem[];
  disclosures: Disclosure[];
}

const BATCH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company_index: { type: "integer", description: "入力の企業番号(0始まり)" },
          summary: { type: "string", description: "初心者向けの日本語要約（100文字程度）" },
          sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
          impact_score: { type: "integer", minimum: 1, maximum: 10 },
          primary_news_index: {
            type: "integer",
            nullable: true,
            description: "その企業のニュース一覧内でのindex。該当なしならnull",
          },
          disclosure_summary: {
            type: "string",
            nullable: true,
            description: "TDnet適時開示があれば、その内容の要約。なければnull",
          },
        },
        required: ["company_index", "summary", "sentiment", "impact_score", "primary_news_index", "disclosure_summary"],
      },
    },
  },
  required: ["results"],
};

function buildBatchPrompt(companies: CompanyInput[]): string {
  const sections = companies.map((c, i) => {
    const newsListText = c.news
      .map((n, ni) => `  ${ni}: ${n.title}（${n.source}, ${n.pubDate}）`)
      .join("\n") || "  （なし）";
    const disclosureListText = c.disclosures.map((d) => `  - ${d.title}（${d.publishedAt}）`).join("\n") || "  （なし）";
    return `## 企業番号${i}: ${c.companyName}\nニュース一覧:\n${newsListText}\n適時開示(TDnet)一覧:\n${disclosureListText}`;
  }).join("\n\n");

  return `あなたは株式投資初心者向けダッシュボードのアシスタントです。
以下は複数企業に関する本日のニュース一覧と適時開示(TDnet)一覧です。企業ごとに、初心者にも分かりやすい言葉で要約し、
その銘柄にとってプラス材料かマイナス材料かを判定してください。売買の推奨は行わず、事実ベースで中立的に記述してください。
ニュース・開示が両方とも「なし」の企業は、summaryに「本日は特筆すべきニュースはありません」と記載し、sentimentはneutral、
impact_scoreは1としてください。

${sections}

各企業番号(company_index)について、必ず1件ずつ結果を返してください。`;
}

const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Geminiの無料枠は "5 requests/min" のようにかなり厳しいため、429時はレスポンスが
// 教えてくれるretryDelay（例: "23s"）だけ待って再試行する。
function parseRetryDelayMs(errorBody: string): number {
  const match = errorBody.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (match) return (parseInt(match[1], 10) + 2) * 1000; // 念のため2秒の余裕を持たせる
  return DEFAULT_RETRY_DELAY_MS;
}

async function callGemini(apiKey: string, prompt: string): Promise<{ results: Array<Record<string, unknown>> }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: BATCH_RESPONSE_SCHEMA,
          },
        }),
      },
    );

    if (res.ok) return parseGeminiResponse(await res.json());

    const bodyText = await res.text();
    lastError = new Error(`Gemini API error: ${res.status} ${bodyText}`);

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delayMs = parseRetryDelayMs(bodyText);
      console.warn(`Gemini rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
      continue;
    }
    throw lastError;
  }

  throw lastError ?? new Error("Gemini API call failed");
}

function parseGeminiResponse(json: unknown): { results: Array<Record<string, unknown>> } {
  const res = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = res?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response did not contain text");
  return JSON.parse(text);
}

// 複数銘柄をまとめて1回のGemini呼び出しで処理し、ticker_symbol -> 分析結果のMapを返す。
// ニュース・開示が両方とも空の銘柄はプロンプトに含めず、呼び出し側でEMPTY_RESULTを補完する。
export async function analyzeCompanyBatch(companies: CompanyInput[]): Promise<Map<string, AnalysisResult>> {
  const result = new Map<string, AnalysisResult>();

  const targets = companies.filter((c) => c.news.length > 0 || c.disclosures.length > 0);
  for (const c of companies) {
    if (c.news.length === 0 && c.disclosures.length === 0) result.set(c.tickerSymbol, EMPTY_RESULT);
  }
  if (targets.length === 0) return result;

  const apiKey = Deno.env.get("GEMINI_API_KEY_JPINVEST");
  if (!apiKey) throw new Error("GEMINI_API_KEY_JPINVEST is not set");

  const prompt = buildBatchPrompt(targets);
  const parsed = await callGemini(apiKey, prompt);

  for (const item of parsed.results ?? []) {
    const index = Number(item.company_index);
    const company = targets[index];
    if (!company) continue;

    const primaryNews =
      typeof item.primary_news_index === "number" ? company.news[item.primary_news_index] : undefined;

    result.set(company.tickerSymbol, {
      summary: (item.summary as string) ?? null,
      headline: primaryNews?.title ?? null,
      url: primaryNews?.link ?? null,
      sentiment: (item.sentiment as AnalysisResult["sentiment"]) ?? null,
      impactScore: (item.impact_score as number) ?? null,
      disclosureSummary: (item.disclosure_summary as string) ?? null,
      disclosureUrl: company.disclosures[0]?.url ?? null,
    });
  }

  // Geminiが一部企業の結果を返さなかった場合に備え、未設定分はEMPTY_RESULTで埋める
  for (const c of targets) {
    if (!result.has(c.tickerSymbol)) result.set(c.tickerSymbol, EMPTY_RESULT);
  }

  return result;
}
