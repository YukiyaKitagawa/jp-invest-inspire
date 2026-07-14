-- 日本株版 AI関連銘柄インテリジェンス: 初期スキーマ
-- 既存Supabaseプロジェクト(米国版と共用)に追加する jp_stock_* / jp_market_holidays テーブル群

-- ---------------------------------------------------------------------------
-- 1. 銘柄マスタ・選定ローテーション管理
-- ---------------------------------------------------------------------------
create table if not exists jp_stock_tickers (
  ticker_symbol text primary key,           -- 証券コード4桁（例: '6758'）。yfinance/Yahoo Finance呼び出し時のみ内部で '.T' を付与する
  company_name text not null,
  sector_category text,                     -- 東証33業種
  theme_tags text[] not null default '{}',  -- 例: {AI,半導体}
  exposure_score numeric,                   -- 直近のGoogle News露出量スコア
  rank int,                                 -- スコア順位。1-50が収集対象、うち1-25が表示対象
  is_active boolean not null default true,  -- 収集プール(上位50)に入っているか
  consecutive_low_weeks int not null default 0, -- スコアが閾値未満だった連続週数（3週で除外）
  added_at timestamptz not null default now(),
  added_reason text,
  removed_at timestamptz,
  removed_reason text,
  created_at timestamptz not null default now()
);

comment on table jp_stock_tickers is '日本株(AI/半導体テーマ)の銘柄マスタと週次ローテーション状態';

-- ---------------------------------------------------------------------------
-- 2. 日次スナップショット（16:30 JST実行分: ニュース・センチメント・指標）
-- ---------------------------------------------------------------------------
create table if not exists jp_stock_intelligence (
  id bigint generated always as identity primary key,
  ticker_symbol text not null references jp_stock_tickers(ticker_symbol),
  recorded_at timestamptz not null default now(),
  current_price numeric,        -- 終値代用（15分足の最終値、円）
  price_change_pct numeric,     -- 前日比(%)
  per_ratio numeric,
  pbr_ratio numeric,
  dividend_yield numeric,
  market_cap bigint,            -- 時価総額（円）
  roe numeric,
  market_sentiment text check (market_sentiment in ('positive','neutral','negative')),
  impact_score smallint check (impact_score between 1 and 10),
  news_summary text,
  news_headline text,
  news_url text,
  disclosure_summary text,      -- TDnet適時開示の補強情報（なければNULL）
  disclosure_url text
);

create index if not exists jp_stock_intelligence_ticker_recorded_idx
  on jp_stock_intelligence (ticker_symbol, recorded_at desc);

comment on table jp_stock_intelligence is '日次(16:30 JST)のニュース・センチメント・ファンダメンタルズ指標スナップショット';

-- 銘柄ごとの最新1件を返すビュー（ダッシュボード一覧表示の高速化用）
create or replace view jp_stock_intelligence_latest as
select distinct on (ticker_symbol) *
from jp_stock_intelligence
order by ticker_symbol, recorded_at desc;

-- ---------------------------------------------------------------------------
-- 3. イントラデイ株価（15分足、取引時間中のみ）
-- ---------------------------------------------------------------------------
create table if not exists jp_stock_intraday_price (
  id bigint generated always as identity primary key,
  ticker_symbol text not null references jp_stock_tickers(ticker_symbol),
  price numeric not null,
  recorded_at timestamptz not null default now()
);

create index if not exists jp_stock_intraday_price_ticker_recorded_idx
  on jp_stock_intraday_price (ticker_symbol, recorded_at desc);

comment on table jp_stock_intraday_price is '取引時間中(9:00-11:30,12:30-15:00 JST)の15分足株価。無期限保持（想定年間12万行程度）';

-- ---------------------------------------------------------------------------
-- 4. 市場カレンダー（休場日）
-- ---------------------------------------------------------------------------
create table if not exists jp_market_holidays (
  date date primary key,
  reason text  -- 祝日名 または '年末年始'
);

comment on table jp_market_holidays is '内閣府「国民の祝日」CSV + 年末年始(12/31,1/2,1/3)を格納。土日はコード側の曜日判定で対応するため保存不要';

-- ---------------------------------------------------------------------------
-- RLS: 匿名読み取り専用（書き込みはservice_roleのEdge Functionsのみ）
-- ---------------------------------------------------------------------------
alter table jp_stock_tickers enable row level security;
alter table jp_stock_intelligence enable row level security;
alter table jp_stock_intraday_price enable row level security;
alter table jp_market_holidays enable row level security;

create policy "Public read access" on jp_stock_tickers for select using (true);
create policy "Public read access" on jp_stock_intelligence for select using (true);
create policy "Public read access" on jp_stock_intraday_price for select using (true);
create policy "Public read access" on jp_market_holidays for select using (true);

grant select on jp_stock_tickers to anon;
grant select on jp_stock_intelligence to anon;
grant select on jp_stock_intelligence_latest to anon;
grant select on jp_stock_intraday_price to anon;
grant select on jp_market_holidays to anon;
