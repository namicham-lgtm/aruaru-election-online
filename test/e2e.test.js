"use strict";
/* 4人がフルラウンドを実プレイするE2Eテスト */
const assert = require("assert");
const { io } = require("socket.io-client");
const URL = "http://localhost:3100";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function once(sock, ev) { return new Promise((r) => sock.once(ev, r)); }
function emitAck(sock, ev, payload) { return new Promise((r) => sock.emit(ev, payload, r)); }

(async () => {
  const names = ["A", "B", "C", "D"];
  const socks = names.map(() => io(URL, { transports: ["websocket"] }));
  await Promise.all(socks.map((s) => once(s, "connect")));

  const states = names.map(() => null);
  socks.forEach((s, i) => s.on("room:state", (st) => (states[i] = st)));
  let thrownEvents = 0;
  socks[3].on("post:thrown", () => thrownEvents++); // Dの画面で同期演出が発火するか

  // ルーム作成・参加
  const created = await emitAck(socks[0], "room:create", { name: "A" });
  assert(created.ok, "create ok");
  const code = created.snapshot.code;
  for (let i = 1; i < 4; i++) {
    const j = await emitAck(socks[i], "room:join", { code, name: names[i] });
    assert(j.ok, names[i] + " join ok");
  }
  await wait(150);
  assert.strictEqual(states[0].players.length, 4, "lobby 4人");

  // 開始（無制限タイマー）
  socks[0].emit("game:start", { seconds: 0 });
  await wait(200);
  assert.strictEqual(states[1].phase, "posting", "postingへ遷移");
  assert(states[1].theme, "テーマが配信される");

  // 投稿: A=4本, B=1本(一点賭け狙い), C=2本, D=2本
  const postPlan = { 0: 4, 1: 1, 2: 2, 3: 2 };
  const postIds = { 0: [], 1: [], 2: [], 3: [] };
  for (const [i, n] of Object.entries(postPlan)) {
    for (let k = 0; k < n; k++) {
      const res = await emitAck(socks[+i], "post:add", { text: `${names[i]}のあるある${k + 1}` });
      assert(res.ok, "post ok");
      postIds[i].push(res.post.id);
    }
  }
  await wait(200);
  assert(thrownEvents >= 9, `Dに同期投函イベントが届く (got ${thrownEvents})`);

  // 全員締切 → collect → gallery（自動遷移）
  socks.forEach((s) => s.emit("post:done"));
  await wait(300);
  assert.strictEqual(states[0].phase, "collect", "collectへ");
  await wait(9 * 230 + 2200);
  assert.strictEqual(states[0].phase, "gallery", "galleryへ自動遷移");
  assert.strictEqual(states[0].posts.length, 9, "匿名一覧 9本");
  assert(states[0].distribution.some((d) => d.posts === 1 && d.people === 1), "分布: 1投稿が1人");
  // 全クライアントで一覧の順序が同一（共通シャッフル）
  const order0 = states[0].posts.map((p) => p.id).join(",");
  const order2 = states[2].posts.map((p) => p.id).join(",");
  assert.strictEqual(order0, order2, "一覧順が全員同じ");
  // mine フラグは本人にだけ
  const bMine = states[1].posts.filter((p) => p.mine).length;
  assert.strictEqual(bMine, 1, "Bのmineは1本");

  // 投票へ（ホスト操作）
  socks[0].emit("gallery:next");
  await wait(200);
  assert.strictEqual(states[3].phase, "voting");
  assert.strictEqual(states[3].allotment, 2, "4人 → 持ち票2");

  // バリデーション: 自票・票数違反が弾かれる
  let bad = await emitAck(socks[1], "vote:submit", { postIds: [postIds[1][0], postIds[0][0]] });
  assert(bad.error, "自分の投稿への投票は拒否");
  bad = await emitAck(socks[1], "vote:submit", { postIds: [postIds[0][0]] });
  assert(bad.error, "票数不足は拒否");

  // 正規投票: Bのb1に全員(A,C,D)が入れる → 一点賭け+5 を狙う
  const b1 = postIds[1][0];
  await emitAck(socks[0], "vote:submit", { postIds: [b1, postIds[2][0]] }); // A → B,C
  await emitAck(socks[2], "vote:submit", { postIds: [b1, postIds[0][0]] }); // C → B,A
  await emitAck(socks[1], "vote:submit", { postIds: [postIds[0][0], postIds[2][0]] }); // B → A,C
  await emitAck(socks[3], "vote:submit", { postIds: [b1, postIds[0][1]] }); // D → B,A
  await wait(300);

  assert.strictEqual(states[0].phase, "results", "全員投票で自動開票");
  const table = states[0].results.table;
  const row = (n) => table.find((r) => r.name === n);
  // 票: A=3(a1×2,a2×1), B=3(全員一致), C=2, D=0
  assert.strictEqual(row("B").total, 3);
  assert(row("B").tags.some((t) => t.label.includes("一点賭け")), "B 一点賭け+5");
  assert.strictEqual(row("B").final, 5 + 5, "B = 1位タイ5pt + 5 = 10");
  assert.strictEqual(row("A").rank, 1, "A,B 1位タイ");
  assert.strictEqual(row("C").rank, 3, "タイ人数分スキップで C は3位");
  assert.strictEqual(row("D").final, 0, "全員タイでないがDは最多でない→ペナなし、0pt");
  assert(states[0].results.reveal && states[0].results.reveal.length === 9, "答え合わせ公開");

  // 再戦
  socks[0].emit("game:again");
  await wait(400);
  assert.strictEqual(states[2].phase, "posting", "再戦で posting に戻る");

  console.log("e2e: all tests passed");
  socks.forEach((s) => s.close());
  process.exit(0);
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
