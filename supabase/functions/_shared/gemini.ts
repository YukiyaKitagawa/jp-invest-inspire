// Geminiによるニュース要約・センチメント判定・影響度スコアリング。
//
// - 複数銘柄を1回のプロンプトにまとめて処理する（レート制限対策）。
// - 使用モデルは固定せず、優先順リスト（環境変数 GEMINI_MODELS_JPINVEST、カンマ区切り。
//   未設定なら DEFAULT_MODELS）を順に試す。
//   Geminiはモデルの世代交代が速く、固定すると廃止・新規利用不可(404)で突然止まるため、
//   404/403/429/5xx/タイムアウトのときは次のモデルに自動で切り替える。レート制限はモデルごとに
//   独立しているので、切替はクォータ超過の回避にもなる。
// - URLはLLMの出力をそのまま信用せず、こちらが渡したニュース一覧のindexで参照させて
//   リンク先のハルシネーションを防ぐ。
import type { NewsItem } from "./googleNews.ts";
import type { Disclosure } from "./tdnet.ts";

// 公式の「新規プロジェクト向け推奨」(3.5 Flash-Lite / 3.8 Flash)を先頭側に置く。
// gemini-3.1-flash-liteは2027-05-07終了予定のため後方。-latestは差し替わるので最後の砦。
const DEFAULT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-flash-lite-latest",
];

const PER_CALL_TIMEOUT_MS = 45_000;
const MIN_REMAINING_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;

export function geminiModelChain(): string[] {
  // 米国株側(GEMINI_MODELS)とは別のモデル構成にできるよう、APIキー(GEMINI_API_KEY_JPINVEST)と同じ流儀で専用名にする
  const configured = (Deno.env.get("GEMINI_MODELS_JPINVEST") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MODELS;
}

export interface AnalysisResult {
  summary: string | null;
  headline: string | null;
  url: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  impactScore: number | null;
  disclosureSummary: string | null;
  disclosureUrl: string | null;
  model: string | null; // 分析に使ったモデル。記事なしの定型結果ではnull
}

// 取得は成功したが該当記事も開示も無い銘柄の定型結果
const NO_NEWS_RESULT: AnalysisResult = {
  summary: "本日は特筆すべきニュースはありません。",
  headline: null,
  url: null,
  sentiment: "neutral",
  impactScore: 1,
  disclosureSummary: null,
  disclosureUrl: null,
  model: null,
};

export interface CompanyInput {
  tickerSymbol: string;
  companyName: string;
  news: NewsItem[];
  newsFailed: boolean; // ニュース取得自体が失敗したか（記事なしとは別扱い）
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
    const emptyNews = c.newsFailed ? "  （取得できませんでした）" : "  （なし）";
    const newsListText = c.news
      .map((n, ni) => `  ${ni}: ${n.title}（${n.source}, ${n.pubDate}）`)
      .join("\n") || emptyNews;
    const disclosureListText = c.disclosures.map((d) => `  - ${d.title}（${d.publishedAt}）`).join("\n") || "  （なし）";
    return `## 企業番号${i}: ${c.companyName}\nニュース一覧:\n${newsListText}\n適時開示(TDnet)一覧:\n${disclosureListText}`;
  }).join("\n\n");

  return `あなたは株式投資初心者向けダッシュボードのアシスタントです。
以下は複数企業に関する本日のニュース一覧と適時開示(TDnet)一覧です。企業ごとに、初心者にも分かりやすい言葉で要約し、
その銘柄にとってプラス材料かマイナス材料かを判定してください。売買の推奨は行わず、事実ベースで中立的に記述してください。
ニュースが「取得できませんでした」の企業は、開示の内容だけから判断し、ニュースについては言及しないでください。

${sections}

各企業番号(company_index)について、必ず1件ずつ結果を返してください。`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(errorBody: string): number | null {
  const match = errorBody.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  return match ? (parseInt(match[1], 10) + 2) * 1000 : null;
}

function parseGeminiResponse(json: unknown): { results: Array<Record<string, unknown>> } {
  const res = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  // thinking系モデルはpartsの先頭が思考用になることがあるため、text を結合して使う
  const text = res?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini response did not contain text");
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.results)) throw new Error("Gemini response missing results array");
  return parsed;
}

// 404/403（廃止・新規利用不可・権限なし）になったモデルは、この実行中は再試行しても無駄なので飛ばす
const unavailableModels = new Set<string>();

// 優先順リストのモデルを順に試す。deadline(epoch ms)を過ぎたら打ち切る。
async function callGeminiWithFallback(
  apiKey: string,
  prompt: string,
  deadline: number,
): Promise<{ parsed: { results: Array<Record<string, unknown>> }; model: string }> {
  const errors: string[] = [];

  for (const model of geminiModelChain()) {
    if (unavailableModels.has(model)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_REMAINING_MS) {
        throw new Error(`Gemini deadline exceeded. ${errors.join(" | ")}`);
      }

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json", responseSchema: BATCH_RESPONSE_SCHEMA },
            }),
            signal: AbortSignal.timeout(Math.min(PER_CALL_TIMEOUT_MS, remaining)),
          },
        );

        if (res.ok) return { parsed: parseGeminiResponse(await res.json()), model };

        const bodyText = await res.text();
        errors.push(`${model}: HTTP ${res.status}`);
        if (res.status === 404 || res.status === 403) unavailableModels.add(model);

        // 429は待ち時間が短ければ同じモデルで1回だけ待って再試行。長ければ次のモデルへ（クォータはモデルごと）
        if (res.status === 429 && attempt === 0) {
          const wait = parseRetryDelayMs(bodyText);
          if (wait !== null && wait <= MAX_RATE_LIMIT_WAIT_MS && deadline - Date.now() > wait + 10_000) {
            console.warn(`Gemini ${model} rate limited, waiting ${wait}ms before one retry`);
            await sleep(wait);
            continue;
          }
        }
        console.warn(`Gemini ${model} failed with HTTP ${res.status}, trying next model: ${bodyText.slice(0, 200)}`);
      } catch (err) {
        // タイムアウト・通信エラー・応答のパース失敗はこのモデルを諦めて次へ
        errors.push(`${model}: ${String(err).slice(0, 120)}`);
        console.warn(`Gemini ${model} error, trying next model: ${String(err).slice(0, 200)}`);
      }
      break; // 次のモデルへ
    }
  }

  throw new Error(`All Gemini models failed. ${errors.join(" | ")}`);
}

// 複数銘柄をまとめて処理し、ticker_symbol -> 分析結果のMapを返す。
// - 記事も開示も無く、取得自体は成功した銘柄 → 定型の中立結果
// - ニュース取得に失敗し開示も無い銘柄 → Mapに含めない（呼び出し側で分析待ちのまま保存し、後で再試行）
// - Geminiが結果を返さなかった銘柄 → 同様にMapに含めない
export async function analyzeCompanyBatch(
  companies: CompanyInput[],
  deadline: number,
): Promise<Map<string, AnalysisResult>> {
  const result = new Map<string, AnalysisResult>();

  const targets = companies.filter((c) => c.news.length > 0 || c.disclosures.length > 0);
  for (const c of companies) {
    if (c.news.length === 0 && c.disclosures.length === 0 && !c.newsFailed) {
      result.set(c.tickerSymbol, NO_NEWS_RESULT);
    }
  }
  if (targets.length === 0) return result;

  const apiKey = Deno.env.get("GEMINI_API_KEY_JPINVEST");
  if (!apiKey) throw new Error("GEMINI_API_KEY_JPINVEST is not set");

  const { parsed, model } = await callGeminiWithFallback(apiKey, buildBatchPrompt(targets), deadline);

  for (const item of parsed.results) {
    const company = targets[Number(item.company_index)];
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
      model,
    });
  }

  return result;
}
