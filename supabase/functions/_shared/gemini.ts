// Geminiによるニュース要約・センチメント判定・影響度スコアリング。
// URLはLLMの出力をそのまま信用せず、こちらが渡したニュース一覧のindexで参照させることで
// リンク先のハルシネーションを防ぐ。
import type { NewsItem } from "./googleNews.ts";
import type { Disclosure } from "./tdnet.ts";

const MODEL = "gemini-2.5-flash";

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

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "初心者向けの日本語要約（100文字程度）" },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    impact_score: { type: "integer", minimum: 1, maximum: 10 },
    primary_news_index: {
      type: ["integer", "null"],
      description: "最も重要なニュースの配列index。該当なしならnull",
    },
    disclosure_summary: {
      type: ["string", "null"],
      description: "TDnet適時開示があれば、その内容の要約。なければnull",
    },
  },
  required: ["summary", "sentiment", "impact_score", "primary_news_index", "disclosure_summary"],
};

export async function analyzeCompanyNews(
  companyName: string,
  newsItems: NewsItem[],
  disclosures: Disclosure[],
): Promise<AnalysisResult> {
  if (newsItems.length === 0 && disclosures.length === 0) return EMPTY_RESULT;

  const apiKey = Deno.env.get("GEMINI_API_KEY_JPINVEST");
  if (!apiKey) throw new Error("GEMINI_API_KEY_JPINVEST is not set");

  const newsListText = newsItems
    .map((n, i) => `${i}: ${n.title}（${n.source}, ${n.pubDate}）`)
    .join("\n") || "（なし）";
  const disclosureListText = disclosures.map((d) => `- ${d.title}（${d.publishedAt}）`).join("\n") || "（なし）";

  const prompt = `あなたは株式投資初心者向けダッシュボードのアシスタントです。
以下は「${companyName}」に関する本日のニュース一覧と適時開示(TDnet)一覧です。

# ニュース一覧
${newsListText}

# 適時開示(TDnet)一覧
${disclosureListText}

これらを踏まえて、初心者にも分かりやすい言葉で要約し、この銘柄にとってプラス材料かマイナス材料かを判定してください。
売買の推奨は行わず、事実ベースで中立的に記述してください。ニュース・開示が両方とも「なし」の場合は、summaryに「本日は特筆すべきニュースはありません」のように記載し、sentimentはneutral、impact_scoreは1としてください。`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response did not contain text");

  const parsed = JSON.parse(text);
  const primaryNews =
    typeof parsed.primary_news_index === "number" ? newsItems[parsed.primary_news_index] : undefined;

  return {
    summary: parsed.summary ?? null,
    headline: primaryNews?.title ?? null,
    url: primaryNews?.link ?? null,
    sentiment: parsed.sentiment ?? null,
    impactScore: parsed.impact_score ?? null,
    disclosureSummary: parsed.disclosure_summary ?? null,
    disclosureUrl: disclosures[0]?.url ?? null,
  };
}
