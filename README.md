# あるある選挙 — オンライン多人数版 v1.0

仕様書 `aruaru-election-spec.md` v1.0 に基づく実装。レビュー観点（§9）への回答と採用した変更は本READMEの「設計判断」を参照。

## 起動

```bash
npm install
npm start          # http://localhost:3000
npm test           # 採点ユニットテスト + 4人フルラウンドE2E
```

ブラウザで開き、1人が「ルームを作成」→ 表示される4桁コードを他の人が入力して参加。スマホ・PC混在OK。

## 環境変数（すべて任意）

| 変数 | 用途 |
|---|---|
| `PORT` | サーバポート（既定 3000） |
| `ANTHROPIC_API_KEY` | お題のAI動的生成を有効化（未設定時は組み込み22テーマ） |
| `THEME_MODEL` | お題生成モデル（既定 `claude-fable-5`） |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | ラウンド結果の永続化を有効化（未設定なら完全インメモリ） |

Supabase を使う場合は `npm install @supabase/supabase-js` と、以下のテーブルを作成:

```sql
create table rounds (
  id bigint generated always as identity primary key,
  room_code text, theme text, player_count int,
  created_at timestamptz default now()
);
create table round_results (
  round_id bigint references rounds(id),
  player_name text, post_count int, total_votes int,
  rank int, final_pts int, tags jsonb
);
```

## 構成

```
server.js            サーバ（ルーム・フェーズ状態機械・同期イベント・再接続）
lib/scoring.js       採点エンジン（仕様 §4 の正実装）
lib/themes.js        お題生成（Claude API / フォールバック）
lib/persistence.js   Supabase アダプタ（任意・no-op対応）
public/index.html    クライアント（ネオン・ナイト、全フェーズ＋同期演出）
test/                ユニット＋E2E
```

サーバが唯一の正。クライアントは `room:state` スナップショットを描画するだけの薄い層。

### 同期演出（仕様 §5.2）
- 投稿確定ごとに `post:thrown` を全クライアントへブロードキャスト → 各画面の投函箱に紙が飛ぶ。投稿者・本文は秘匿。
- 投票確定ごとに `vote:cast`（進捗人数つき）。
- 集約フェーズはサーバが全員同時に開始し、所要時間後に自動で鑑賞フェーズへ遷移。
- タイマーは `postingEndsAt`（epoch ms）を一度配信し各クライアントでカウントダウン描画。

### 再接続
参加時に発行する `playerToken` を sessionStorage に保持。切断→再接続時はトークンで本人復帰し、最新スナップショットを受け取って続行できる。

## 設計判断（仕様書 §9 レビューへの回答）

1. **Phaser.js は不採用（変更）。** 演出が「紙が飛ぶ・箱が揺れる」程度のためCSSアニメで十分。バンドル削減とテキスト入力との相性を優先。Socket.io / Node / Supabase は仕様どおり。
2. **採点に1ガード追加（変更）。** 全員の投稿数が同数のとき「最多投稿×圏外 −6」を発火させない（全員が"最多"扱いになり下位が理不尽に減点されるため）。`lib/scoring.js` の `SKIP_MAX_PENALTY_WHEN_ALL_TIED` を false にすれば仕様書の文字どおりに戻る。
3. **同期はイベントブロードキャスト＋サーバ権威で実装。** タイマーは endsAt 方式（毎秒tickより通信断に強い）。
4. **縮退対策は持ち票の動的頭打ち** `min(N−2, 5, 他人の投稿数)` **をサーバで強制**し、投稿が極端に少ないラウンドは投票画面に警告表示（強制中断はしない）。
5. **開票で投稿者を公開する「答え合わせ」を追加（提案）。** 鑑賞フェーズの「これ誰が書いた？」の回収として最大の見せ場になるため。不要なら `server.js` の `REVEAL_AUTHORS_IN_RESULTS` を false に。

## デプロイの目安

WebSocket常時接続のため、Render / Railway / Fly.io などのNode常駐ホスティングが素直（Vercelのサーバレスは不向き）。単一プロセス・インメモリ前提なので、スケールアウトする場合は Socket.io の Redis アダプタ追加が必要。
