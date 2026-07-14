-- cronスケジュール設定（pg_cron + pg_net + Vault）
-- Supabaseダッシュボード → SQL Editor で実行する。
--
-- service_role keyをcronジョブ本文に直接埋め込むと cron.job テーブルに平文で残るため、
-- Supabase Vaultに一度だけ登録し、各ジョブはVault経由で参照する。
--
-- 事前準備:
--   1. Database → Extensions で pg_cron / pg_net / supabase_vault を有効化
--   2. 下の <SERVICE_ROLE_KEY> をProject Settings → API の実際の値に置き換えてから、
--      この create_secret の行だけを一度実行する（実行後、この行はSQL Editor上から削除して問題ない。
--      実値を含むファイルをこのままgitにコミットしないこと）
select vault.create_secret('<SERVICE_ROLE_KEY>', 'jp_stock_service_role_key');

-- 時刻はUTC指定（日本時間 = UTC+9）。
--   09:00-15:00 JST（取引時間帯を広めにカバー、function側で正確な時間外判定を行う） = 00:00-06:59 UTC
--   16:30 JST（日次分析） = 07:30 UTC
--   毎週月曜07:00 JST（週次選定） = 日曜22:00 UTC
--   毎年12/1 00:00 UTC（市場カレンダー年次更新）

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'jp-stock-intraday-price',
  '*/15 0-6 * * 1-5',
  $$
  select net.http_post(
    url := 'https://jkacguhaabaqtrjaahgl.supabase.co/functions/v1/jp-stock-intraday-price',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jp_stock_service_role_key'),
      'Content-Type', 'application/json'
    )
  );
  $$
);

select cron.schedule(
  'jp-stock-daily-digest',
  '30 7 * * 1-5',
  $$
  select net.http_post(
    url := 'https://jkacguhaabaqtrjaahgl.supabase.co/functions/v1/jp-stock-daily-digest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jp_stock_service_role_key'),
      'Content-Type', 'application/json'
    )
  );
  $$
);

select cron.schedule(
  'jp-stock-ticker-review',
  '0 22 * * 0',
  $$
  select net.http_post(
    url := 'https://jkacguhaabaqtrjaahgl.supabase.co/functions/v1/jp-stock-ticker-review',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jp_stock_service_role_key'),
      'Content-Type', 'application/json'
    )
  );
  $$
);

select cron.schedule(
  'jp-market-calendar-sync',
  '0 0 1 12 *',
  $$
  select net.http_post(
    url := 'https://jkacguhaabaqtrjaahgl.supabase.co/functions/v1/jp-market-calendar-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jp_stock_service_role_key'),
      'Content-Type', 'application/json'
    )
  );
  $$
);

-- 確認: select * from cron.job;
-- 削除する場合: select cron.unschedule('ジョブ名');
