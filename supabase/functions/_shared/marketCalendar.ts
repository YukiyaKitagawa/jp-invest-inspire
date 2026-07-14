import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// JSTの暦日で "YYYY-MM-DD" を返す
export function jstDateKey(input: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(input);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function jstWeekday(input: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short" }).format(input);
}

// 取引日か判定する（土日 または jp_market_holidays 該当日なら休場）
export async function isTradingDay(client: SupabaseClient, date: Date = new Date()): Promise<boolean> {
  const weekday = jstWeekday(date);
  if (weekday === "Sat" || weekday === "Sun") return false;

  const dateKey = jstDateKey(date);
  const { data, error } = await client
    .from("jp_market_holidays")
    .select("date")
    .eq("date", dateKey)
    .maybeSingle();

  if (error) throw error;
  return data === null;
}

// 取引時間中(9:00-11:30, 12:30-15:00 JST)かどうかを判定する
export function isWithinTradingHours(date: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const minutesOfDay = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);

  const morningStart = 9 * 60;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 12 * 60 + 30;
  const afternoonEnd = 15 * 60;

  return (
    (minutesOfDay >= morningStart && minutesOfDay <= morningEnd) ||
    (minutesOfDay >= afternoonStart && minutesOfDay <= afternoonEnd)
  );
}
