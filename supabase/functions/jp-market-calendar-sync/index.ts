// 市場カレンダー同期: 内閣府「国民の祝日」CSVを取り込み、東証年末年始休場日(12/31,1/2,1/3)を
// 現在年+翌年分について補完する。年1回(12月頃)の実行を想定。手動invokeでの初回投入にも使う。
import { createServiceClient } from "../_shared/supabaseClient.ts";

const HOLIDAY_CSV_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";

function parseHolidayCsv(text: string): { date: string; reason: string }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: { date: string; reason: string }[] = [];
  // 1行目はヘッダー
  for (const line of lines.slice(1)) {
    const [dateStr, name] = line.split(",");
    if (!dateStr || !name) continue;
    const [y, m, d] = dateStr.trim().split("/").map((v) => parseInt(v, 10));
    if (!y || !m || !d) continue;
    rows.push({
      date: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      reason: name.trim(),
    });
  }
  return rows;
}

function yearEndRows(years: number[]): { date: string; reason: string }[] {
  const rows: { date: string; reason: string }[] = [];
  for (const y of years) {
    rows.push({ date: `${y}-12-31`, reason: "年末休場" });
    rows.push({ date: `${y}-01-02`, reason: "年始休場" });
    rows.push({ date: `${y}-01-03`, reason: "年始休場" });
  }
  return rows;
}

Deno.serve(async () => {
  try {
    const client = createServiceClient();

    const res = await fetch(HOLIDAY_CSV_URL);
    if (!res.ok) throw new Error(`祝日CSV取得に失敗しました: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("shift-jis").decode(buf);

    const currentYear = new Date().getFullYear();
    const rows = [
      ...parseHolidayCsv(text).filter((r) => parseInt(r.date.slice(0, 4), 10) >= currentYear - 1),
      ...yearEndRows([currentYear - 1, currentYear, currentYear + 1, currentYear + 2]),
    ];

    const { error } = await client
      .from("jp_market_holidays")
      .upsert(rows, { onConflict: "date" });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, rows: rows.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
