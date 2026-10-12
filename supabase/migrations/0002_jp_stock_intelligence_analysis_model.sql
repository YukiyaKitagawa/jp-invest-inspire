-- 分析に使用したGeminiモデル名を記録する列を追加（モデルを自動切替するため、品質変化の追跡用）
alter table jp_stock_intelligence add column if not exists analysis_model text;
comment on column jp_stock_intelligence.analysis_model is '分析に使用したGeminiモデル名。NULLは分析待ち、または記事なしの定型結果';

-- jp_stock_intelligence_latest は select distinct on (...) * のため、ビューを再作成して新列を反映する
create or replace view jp_stock_intelligence_latest as
select distinct on (ticker_symbol) *
from jp_stock_intelligence
order by ticker_symbol, recorded_at desc;

grant select on jp_stock_intelligence_latest to anon;
