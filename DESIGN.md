# 日本株版 AI関連銘柄インテリジェンス ダッシュボード 設計ドキュメント

米国株版（[Investment](https://github.com/YukiyaKitagawa/invest-inspire)）と同じ「株価×ニュース×AIセンチメント分析」の枠組みを踏襲しつつ、対象を日本株（AI・半導体テーマ）に再定義したもの。本ドキュメントは実装・デプロイ・実運用テストを経た最終状態を記録する。

- 公開URL: https://yukiyakitagawa.github.io/jp-invest-inspire/
- リポジトリ: https://github.com/YukiyaKitagawa/jp-invest-inspire
- Supabaseプロジェクト: `jkacguhaabaqtrjaahgl`（米国版と共用、テーブル名を`jp_`で分離）

---

## 1. 概要

| 項目 | 内容 |
|---|---|
| 対象テーマ | AI・半導体関連の日本株 |
| ベースアーキテクチャ | 米国版と同じ（Supabase Edge Functions + Postgres + 静的HTML/JSダッシュボード） |
| 米国版との違い | 株価API、ニュース収集元、収集頻度（15分足＋日次）、通貨表示、追加指標、候補プールの母集団 |

---

## 2. 対象銘柄と選定ロジック

| 項目 | 内容 |
|---|---|
| 収集対象 | スコア上位**50銘柄**まで |
| 表示対象 | 収集対象のうち上位**25銘柄** |
| 候補プール | 東証33業種の「電気機器」「精密機器」「情報・通信業」を中心に、AI側で**47銘柄**の初期シードを作成（`supabase/seed/jp_stock_tickers_seed.sql`） |
| スコアリング方法 | 過去7日間、企業名＋キーワード（AI／半導体／生成AI／GPU／データセンター／ファウンドリ）でGoogle Newsを日本語検索し、ヒット件数を露出量スコアとする |
| 除外 | スコア順位が上位50位圏外の状態が**3週連続**で続いたら収集対象から除外（ヒステリシス） |
| 実行頻度 | 週次（毎週月曜07:00 JST） |

**運用上の注意**: 候補プール(47件)は収集上限(50)より少ないため、現状は事実上ほぼ全銘柄が収集対象になる。候補プールを広げたい場合は`jp_stock_tickers`に手動で行を追加する（自動発掘機能は無い）。

初回の週次選定を手動実行した結果、**新光電気工業(6967)**と**NTTデータグループ(9613)**がTOB非公開化により上場廃止済みと判明したため、`is_active=false`に手動更新し、シードSQLからもコメントアウトした。実質稼働銘柄は**45**。

---

## 3. データ収集アーキテクチャ

### 3.1 株価データ

| 項目 | 内容 |
|---|---|
| データソース | yfinance相当（Yahoo Financeの`query1/query2.finance.yahoo.com`エンドポイントを直接fetch。非公式のため失敗時は欠損許容） |
| 収集頻度 | 15分足、取引時間中のみ（9:00-11:30, 12:30-15:00 JST） |
| レート制限対策 | 収集対象銘柄をまとめて1サイクルでバッチ取得 |
| 終値の扱い | 別途EOD取得は行わず、15分足の最終値を終値として採用 |
| ファンダメンタルズ | PER・PBR・配当利回り・時価総額・ROEもYahoo Financeから取得。欠損時は「データなし」と明示 |

### 3.2 ニュース・センチメント分析

| 項目 | 内容 |
|---|---|
| 実行頻度 | 1日1回、**16:30 JST**（大引け後） |
| 主材料 | Google News日本語検索 |
| 補強材料 | TDnet適時開示（非公式ミラーAPI経由） |
| 分析処理 | Geminiで要約・センチメント・影響度をバッチ判定 |

### 3.3 Geminiバッチ処理とレート制限対策（実装中に判明した問題）

当初`gemini-2.5-flash`を銘柄ごとに1回ずつ呼ぶ設計だったが、実運用テストで以下が判明し、設計を変更した。

| 問題 | 対応 |
|---|---|
| `gemini-2.5-flash`の無料枠は**5 requests/分**と非常に厳しい | 15銘柄ずつバッチ化し、1回のプロンプトで複数銘柄を処理（45銘柄で約3回の呼び出しに削減） |
| `responseSchema`で`type: ["integer","null"]`のようなJSON Schema配列形式のtypeがGemini側で拒否される（400エラー） | `type: "integer", nullable: true`という OpenAPI 3.0形式に修正 |
| `gemini-2.5-flash-lite`は新規プロジェクトのAPIキーでは404（利用不可） | 実際に`/v1beta/models`を問い合わせて確認できた`gemini-3.1-flash-lite`に変更（**2026-10にモデル固定をやめ、優先順リストの自動切替に変更。§11参照**） |
| バッチ呼び出しが429（レート制限）で失敗することがある | `retryDelay`をレスポンスから読み取り、待機して自動リトライ（最大2回） |
| リトライしても失敗した銘柄が残るケース | `jp_stock_intelligence.market_sentiment IS NULL`を「分析待ち」の目印とし、日次分析は失敗銘柄があっても全体を止めずに継続。別関数`jp-stock-reanalyze-pending`が拾って再分析する |

---

## 4. データベース設計

テーブル名は米国版の`ai_stock_*`を踏襲し、`jp_stock_*`に変更（同一Supabaseプロジェクト内で共存）。

### `jp_stock_tickers`（銘柄マスタ・選定ローテーション管理）

| カラム | 型 | 内容 |
|---|---|---|
| ticker_symbol | text (PK) | 証券コード4桁（yfinance呼び出し時のみ内部で`.T`を付与） |
| company_name | text | 企業名 |
| sector_category | text | 東証33業種 |
| theme_tags | text[] | `{AI,半導体}`等 |
| exposure_score | numeric | 直近のGoogle News露出量スコア |
| rank | int | スコア順位（1〜50が収集対象、うち1〜25が表示対象） |
| is_active | boolean | 収集プールに入っているか |
| consecutive_low_weeks | int | スコアが閾値未満だった連続週数 |
| added_at / added_reason | timestamptz / text | 収集プール入り日・理由 |
| removed_at / removed_reason | timestamptz / text | 収集プール除外日・理由 |

### `jp_stock_intelligence`（日次スナップショット、16:30 JST実行分）

| カラム | 型 | 内容 |
|---|---|---|
| ticker_symbol | text (FK) | 証券コード |
| recorded_at | timestamptz | 記録時刻 |
| current_price / price_change_pct | numeric | 終値代用・前日比 |
| per_ratio / pbr_ratio / dividend_yield / market_cap / roe | numeric | 追加指標5種 |
| market_sentiment | text | positive/neutral/negative。**NULLは分析待ち（再試行対象）を意味する** |
| impact_score | smallint | 1〜10 |
| news_summary / news_headline / news_url | text | Google Newsベースの要約 |
| disclosure_summary / disclosure_url | text | TDnet開示があれば補強情報 |

→ `jp_stock_intelligence_latest`ビューが銘柄ごとの最新1件を返す。

### `jp_stock_intraday_price`（15分足）

無期限保持（25〜50銘柄×20回/日×245営業日で年間12万行程度、規模的に削除不要と判断）。

### `jp_market_holidays`（市場カレンダー）

内閣府「国民の祝日」CSV＋年末年始(12/31,1/2,1/3)を格納。土日はコード側の曜日判定。

---

## 5. Edge Functions構成

| 関数名 | 実行頻度 | 役割 |
|---|---|---|
| `jp-stock-intraday-price` | 15分毎（取引時間帯を広めにカバーし関数内で正確判定） | 15分足株価収集 |
| `jp-stock-daily-digest` | 16:30 JST 平日 | ニュース・センチメント分析（Geminiバッチ） |
| `jp-stock-reanalyze-pending` | 17:15 JST 平日 | 直近3日分の分析待ち（`market_sentiment IS NULL`）銘柄の再試行（手動実行は`?days=N`で遡り日数を指定可） |
| `jp-stock-ticker-review` | 毎週月曜07:00 JST | 銘柄選定ローテーション |
| `jp-market-calendar-sync` | 毎年12/1 | 内閣府祝日CSVの年次取り込み |

cronは`pg_cron`+`pg_net`で構成し、service_role keyはSupabase Vaultに`jp_stock_service_role_key`として保存、各ジョブはVault経由で参照する（`cron.job`テーブルに平文を残さないため）。

---

## 6. 市場カレンダー

| 項目 | 内容 |
|---|---|
| 祝日データソース | 内閣府「国民の祝日」CSV |
| TSE特有の休場日 | 12/31・1/2・1/3を`jp-market-calendar-sync`が毎年補完 |
| 判定ロジック | `is_trading_day = 曜日が土日でない AND jp_market_holidays に該当日がない` |
| 適用箇所 | 15分足収集・日次分析の両方が実行開始時に判定し、非営業日ならスキップ |

---

## 7. 追加指標・用語解説

米国版（価格・前日比・センチメント・影響度・ニュース要約）に加え、PER・PBR・配当利回り・時価総額・ROEの5指標を追加。欠損時は「データなし」と明示する方針（値を隠したり0で埋めない）。`GLOSSARY`にTDnet適時開示の説明も追加。

---

## 8. UI設計

- タブ構成: 「銘柄一覧」「本日の値動き」「価格推移」の3タブ
- カード: 追加指標5つを2行グリッドで表示
- 通貨表示: `¥`表記・整数カンマ区切り、時価総額は兆/億円単位に変換

**実装中に判明したバグ**: Chart.jsは非表示（`display:none`）のタブ内で初期化されると canvas サイズが0で固定され、タブを表示に切り替えても自動では直らない。`.trend-chart-wrap`に固定高さ＋`position:relative`を指定し、Chart.js側は`maintainAspectRatio:false`、かつタブ切り替え時に該当チャートの`.resize()`を明示的に呼ぶことで解決した。

---

## 9. LINE通知（米国版との統合）

米国版の`ai-stock-daily-digest`（毎日07:10 JST、LINE個人pushでUS Top3を配信）を拡張し、**同じ1回のpush呼び出しの中に日本株Top3も含める**形にした（メッセージ送信数の節約が目的で、JP単独の配信は追加しない）。

| 項目 | 内容 |
|---|---|
| 配信タイミング | 07:10 JST（米国市場引けの1〜2時間後） |
| US分の鮮度 | 当日引け直後の新鮮なデータ |
| JP分の鮮度 | **前営業日16:30 JST時点**（当日のJP市場はまだ開いていないため） |
| ランキング基準 | `impact_score×2 + |price_change_pct|`（US/JP共通ロジック） |
| 文字数対策 | LINEのtextメッセージはUTF-16で2000文字以内という制約があるため、送信直前に長さを確認し、超過時は末尾を切り詰めて送信を継続する（全く送らないより有用と判断） |

実装ファイルは`Investment`リポジトリの`supabase/functions/ai-stock-daily-digest/index.ts`（米国版側で管理・バージョン管理）。

---

## 10. デプロイ構成

| 項目 | 内容 |
|---|---|
| Supabaseプロジェクト | 米国版と共用（`jkacguhaabaqtrjaahgl`）、テーブル名で分離 |
| リポジトリ | `jp-invest-inspire`（米国版とは別のGitHub Pagesサイト） |
| Gemini APIキー | 新規発行、Supabaseシークレット名`GEMINI_API_KEY_JPINVEST`（米国版とは別キーでクォータを分離） |
| フロントエンド公開 | GitHub Pages（`main`ブランチ、`/`ルート） |

---

## 11. 障害対応と耐障害設計（2026-10の障害を受けた改修）

2026-10-08〜09、日本株のLINE配信からJP欄が消えた。原因はGeminiではなく**Google Newsが記事を返さなかった（HTTP 503）**こと。
記事ゼロの銘柄は`market_sentiment`がNULLになり、LINEはNULLを除外してJP欄ごと省略していた。
さらに10/11の週次選定では、取得失敗を「スコア0」として扱い**全47銘柄の露出量スコアが0へ上書き**された。
同時期に米国側`ai-stock-intelligence`が504（約150秒でタイムアウト）となり、行が保存されなかった（原因はタイムアウト未設定のfetchが固まったと推定。過去ログが無く断定はできない）。

| 問題 | 対応 |
|---|---|
| 取得失敗と「記事なし」が区別されず、失敗が中立判定・スコア0として記録された | `fetchNews`が`ok`フラグを返す。失敗した銘柄は分析待ち(NULL)のまま保存し、記事なしが確定した銘柄だけ定型の中立結果にする |
| Google Newsの断続的な503 | タイムアウト10秒・最大3回のバックオフ再試行・並列数3・RSS以外の応答は失敗扱い |
| 再試行が当日分しか見ず、日をまたぐと未分析のまま残る | 直近3日分を対象にする（`?days=N`で手動補完可）。過去日の行には再試行時点の最新ニュースで分析が入る点に注意 |
| 週次選定が失敗を0点扱いして順位が壊れた | 取得失敗が3割超なら**何も更新せず中止**。一部の失敗は前回スコアで順位付けし、その銘柄のスコア・連続低スコア週数は据え置く |
| LINEが最新行の分析が空だとJP欄を黙って省略 | 直近7日の**最新の分析済み日にフォールバック**し、遅れている場合は注記。7日間データが無い場合も省略せず状況を明示 |
| LINEの米国欄の見出しが実行日を常に表示し、古いデータが「本日」に見えた | データの実際の記録日を表示し、実行日と異なれば注記 |
| モデル固定（3.1-flash-liteは2027-05-07終了予定、2.5系は新規利用不可）で突然止まる | 優先順リスト＋自動切替（環境変数`GEMINI_MODELS_JPINVEST`、米国側は`GEMINI_MODELS`で上書き可）。404/403のモデルは同一実行中スキップ |
| 外部呼び出しがタイムアウト未設定で、関数全体が固まりうる | すべてのfetchにタイムアウトを設定。日次分析は収集60秒・全体130秒の時間予算を設け、150秒の上限前に必ず保存へ到達させる |

動作確認用に、`jp-stock-daily-digest`と米国側`ai-stock-daily-digest`は`?dryRun=1`でDB書き込み・LINE送信なしに全処理を実行できる。

**運用メモ**
- 使用モデルは`jp_stock_intelligence.analysis_model`で追跡できる（NULLは分析待ち、または記事なしの定型結果）
- Geminiの無料枠は公式がモデル別の数値を公開していないため、AI Studioで確認する
- Google Newsが長期間ブロックされる場合の代替（他RSS、Geminiのグラウンディング）は未検証。必要になった時点で調査する

---

## まとめ

1. 対象はAI・半導体テーマの日本株。収集は上位50銘柄、表示は上位25銘柄とする設計で、実際の候補プールは47銘柄（うち2銘柄は上場廃止が判明し除外、実働45銘柄）
2. 株価はyfinance相当のYahoo Finance直接fetchで15分足を取得、終値は別途EOD取得せず15分足の最終値を代用する
3. ニュース・センチメント分析は16:30 JST実行。Geminiは銘柄ごとではなく15銘柄バッチで呼び出し、429時は自動リトライ、それでも失敗した銘柄は`jp-stock-reanalyze-pending`（17:15 JST）が拾う二段構えとした
4. Geminiモデルは固定せず、優先順リスト（既定: `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.8-flash` → `gemini-flash-lite-latest`）を404/403/429/5xx/タイムアウトで自動切替し、使用モデルを`analysis_model`に記録する
5. DBは`jp_stock_tickers`・`jp_stock_intelligence`(+latestビュー)・`jp_stock_intraday_price`・`jp_market_holidays`の4テーブル構成。市場カレンダーで非営業日をスキップする
6. UIはChart.jsの非表示タブ内初期化バグに対応し、指標2行グリッド・イントラデイタブ・円表示を実装
7. 米国版のLINE配信を拡張し、1回のpushにUS Top3とJP Top3(前営業日)を統合、文字数上限(2000 UTF-16文字)を確認・切り詰める安全策を実装した
