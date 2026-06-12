"use strict";
/**
 * あるある選挙 採点エンジン（仕様書 §4 の正実装）
 *
 * 入力:
 *   players: [{ id, name, postIds: [postId, ...] }]
 *   votes:   { [postId]: voterId[] }   // 1投稿1票/人 はサーバ側で保証済み
 *
 * 出力: プレイヤーごとの { rank, total, rankPts, bonus, pen, final, tags[] }
 */

// レビュー提案(§9-2): 全員の投稿数が同数のとき「最多投稿×圏外 −6」を発火させない。
// false にすると仕様書 §4.3 の文字どおり（全員タイでも適用）になる。
const SKIP_MAX_PENALTY_WHEN_ALL_TIED = true;

const RANK_PTS = { 1: 5, 2: 3, 3: 1 };

function computeResults(players, votes) {
  const N = players.length;
  const unanimousNeed = N - 1; // 「全員」= 自分以外の全員

  const voteCount = {};
  for (const [postId, voters] of Object.entries(votes)) {
    voteCount[postId] = voters.length;
  }

  const rows = players.map((p) => {
    const postCount = p.postIds.length;
    const total = p.postIds.reduce((s, id) => s + (voteCount[id] || 0), 0);
    const unanimousPosts = p.postIds.filter(
      (id) => (voteCount[id] || 0) === unanimousNeed && unanimousNeed > 0
    ).length;
    return { id: p.id, name: p.name, postCount, total, unanimousPosts };
  });

  const maxPost = Math.max(...rows.map((r) => r.postCount));
  const minPost = Math.min(...rows.map((r) => r.postCount));
  const allTiedOnPosts = maxPost === minPost;

  for (const r of rows) {
    // §4.2 同点は上位点・タイ人数分スキップ: rank = 1 + (自分より総得票が多い人数)
    r.rank = 1 + rows.filter((o) => o.total > r.total).length;
    r.rankPts = RANK_PTS[r.rank] || 0;
    const inTop3 = r.rank <= 3;

    const tags = [];
    let bonus = 0;
    let pen = 0;

    // §4.4 ボーナス（一点賭け優先・排他）
    if (r.postCount === 1 && r.unanimousPosts >= 1) {
      bonus += 5;
      tags.push({ kind: "plus", label: "一点賭け +5" });
    } else if (r.postCount >= 2 && r.unanimousPosts >= 1) {
      const b = r.unanimousPosts * 2; // 加算式
      bonus += b;
      tags.push({ kind: "plus", label: `満場一致×${r.unanimousPosts} +${b}` });
    }

    // §4.3 ペナルティ（0投稿を優先、二重適用なし）
    if (r.postCount === 0) {
      pen -= 6;
      tags.push({ kind: "minus", label: "0投稿 −6" });
    } else if (
      r.postCount === maxPost &&
      !inTop3 &&
      !(SKIP_MAX_PENALTY_WHEN_ALL_TIED && allTiedOnPosts)
    ) {
      pen -= 6;
      tags.push({ kind: "minus", label: "最多投稿×圏外 −6" });
    }

    r.bonus = bonus;
    r.pen = pen;
    r.tags = tags;
    r.final = r.rankPts + bonus + pen;
  }

  rows.sort((a, b) => b.final - a.final || b.total - a.total);
  return rows;
}

/** 投票権 = min(参加人数−2, 5, 投票可能な他人の投稿数) — 仕様 §3⑤ + 縮退対策 */
function voteAllotment(playerCount, othersPostCount) {
  return Math.min(Math.max(playerCount - 2, 0), 5, othersPostCount);
}

module.exports = { computeResults, voteAllotment, SKIP_MAX_PENALTY_WHEN_ALL_TIED };
