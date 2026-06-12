"use strict";
const assert = require("assert");
const { computeResults, voteAllotment } = require("../lib/scoring");

function mk(players, voteMap) {
  // players: {name: postIds[]}, voteMap: {postId: voterNames[]}
  const ps = Object.entries(players).map(([name, postIds]) => ({ id: name, name, postIds }));
  return computeResults(ps, voteMap);
}
const get = (rows, name) => rows.find((r) => r.name === name);

/* --- 1. 会話で検証した4人ラウンド（仕様書の代表例） ---
   A: 10投稿で2票(4位) → 最多×圏外 −6 = −6
   B: 1投稿に全員(3人) → 2位3pt + 一点賭け5 = 8
   C: 5投稿4票 1位 = 5
   D: 2投稿、うち1本が全員一致(3票) → 2位タイ3pt + 満場一致2 = 5  */
{
  const players = {
    A: ["a1","a2","a3","a4","a5","a6","a7","a8","a9","a10"],
    B: ["b1"], C: ["c1","c2","c3","c4","c5"], D: ["d1","d2"],
  };
  const votes = {
    a1:["B"], a2:["C"],            // A: 2票
    b1:["A","C","D"],              // B: 3票（全員一致）
    c1:["A"], c2:["B"], c3:["D"], c4:["A"], // C: 4票
    d1:["B","C","A"],              // D: 3票（d1が全員一致）
  };
  // 票数チェック: 各自 voteAllot = min(4-2,5)=2... 待て、この例は会話時の「3票」前提。
  // ここでは採点ロジックの検証が目的なので票の総数制約は問わない。
  const r = mk(players, votes);
  assert.strictEqual(get(r,"A").final, -6, "A=-6");
  assert.strictEqual(get(r,"B").final, 8, "B=8 (3pt+一点賭け5)");
  assert.strictEqual(get(r,"C").final, 5, "C=5 (1位)");
  assert.strictEqual(get(r,"D").final, 5, "D=5 (3pt+満場一致2)");
  assert.strictEqual(get(r,"B").rank, 2);
  assert.strictEqual(get(r,"D").rank, 2);
  assert.strictEqual(get(r,"A").rank, 4, "2位タイ2人 → 次は4位（タイ人数分スキップ）");
}

/* --- 2. 満場一致の加算式: 2本全員一致なら +4 --- */
{
  const players = { A: ["a1","a2"], B: ["b1"], C: ["c1"], D: ["d1"] };
  const votes = {
    a1:["B","C","D"], a2:["B","C","D"], // A: 2本とも全員一致 → +4
    b1:["A"], c1:["A"],
  };
  const r = mk(players, votes);
  const A = get(r,"A");
  assert.strictEqual(A.bonus, 4, "満場一致×2 = +4");
  assert.strictEqual(A.final, 5 + 4, "1位5pt + 4");
}

/* --- 3. 一点賭けは満場一致と排他（+5のみ） --- */
{
  const players = { A: ["a1"], B: ["b1","b2"], C: ["c1"], D: [] };
  const votes = { a1:["B","C","D"], b1:["A","C"], c1:["A"] };
  const r = mk(players, votes);
  assert.strictEqual(get(r,"A").bonus, 5, "一点賭けは+5のみ");
  assert.strictEqual(get(r,"D").pen, -6, "0投稿 −6");
  assert.strictEqual(get(r,"D").tags.length, 1, "0投稿に最多ペナルティを重ねない");
}

/* --- 4. 全員同数投稿なら最多×圏外を発火させない（レビュー提案ガード） --- */
{
  const players = { A:["a1"], B:["b1"], C:["c1"], D:["d1"], E:["e1"] };
  const votes = { a1:["B","C"], b1:["A","D"], c1:["E"], d1:["C"], e1:["A","B","D","E"].slice(0,0) };
  // E: 0票 5位、全員1投稿（タイ）→ ペナルティなし
  const r = mk(players, votes);
  assert.strictEqual(get(r,"E").pen, 0, "全員同数ならペナルティなし");
}

/* --- 5. 1位3人タイ → 全員5pt、次は4位0pt --- */
{
  const players = { A:["a1"], B:["b1"], C:["c1"], D:["d1","d2"] };
  const votes = { a1:["B","C"], b1:["A","D"], c1:["D","A"], d1:["B"] };
  const r = mk(players, votes);
  assert.strictEqual(get(r,"A").rankPts, 5);
  assert.strictEqual(get(r,"B").rankPts, 5);
  assert.strictEqual(get(r,"C").rankPts, 5);
  assert.strictEqual(get(r,"D").rank, 4, "1位タイ3人 → 次は4位");
  assert.strictEqual(get(r,"D").rankPts, 0);
}

/* --- 6. 投票権の式 --- */
assert.strictEqual(voteAllotment(4, 99), 2);
assert.strictEqual(voteAllotment(5, 99), 3);
assert.strictEqual(voteAllotment(7, 99), 5);
assert.strictEqual(voteAllotment(10, 99), 5, "上限5");
assert.strictEqual(voteAllotment(6, 3), 3, "他人の投稿数で頭打ち（縮退対策）");

console.log("scoring: all tests passed");
