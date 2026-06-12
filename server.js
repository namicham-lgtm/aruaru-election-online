"use strict";
/**
 * あるある選挙 オンライン版サーバ
 *
 * 設計方針（仕様 §5.2 / レビュー §9-3 反映）:
 *  - サーバが唯一の正（フェーズ・タイマー・投稿・票・採点すべてサーバ管理）
 *  - 演出同期: 投函のたびに `post:thrown` を全員へブロードキャスト（投稿者・本文は秘匿）
 *  - タイマーは endsAt(epoch ms) を一度配信し、各クライアントが描画（毎秒tickより通信断に強い）
 *  - 再接続: playerToken で本人復帰 → 最新スナップショット再送
 */
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { computeResults, voteAllotment } = require("./lib/scoring");
const { generateTheme } = require("./lib/themes");
const persistence = require("./lib/persistence");

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;          // 動作可能下限（推奨は4。ロビーで注意表示）
const RECOMMENDED_PLAYERS = 4;
const MAX_PLAYERS = 12;
const COLLECT_MS_PER_PAPER = 230;
const REVEAL_AUTHORS_IN_RESULTS = true; // レビュー §9-5 提案: 開票で投稿者を公開
// 投票フェーズで切断/離脱したプレイヤーを自動スキップするまでの猶予（テスト用に可変）
const VOTE_GRACE_MS = process.env.VOTE_GRACE_MS ? Number(process.env.VOTE_GRACE_MS) : 45000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_q, r) => r.json({ ok: true }));
const server = http.createServer(app);
const io = new Server(server);

/** rooms: code -> room */
const rooms = new Map();
let postSeq = 1;

function makeRoom(code) {
  return {
    code,
    phase: "lobby", // lobby | posting | collect | gallery | voting | results
    theme: null,
    themeHistory: [],
    totalMatches: 3,
    currentMatch: 1,
    hostToken: null,    // ホストの token（作成時に設定。切断/離脱で移譲）
    postingSeconds: 120,
    postingEndsAt: null,
    postingTimer: null,
    players: new Map(), // token -> {token, name, socketId|null, posts, doneRound, votedIds|null, left, skipped, cumulative}
    votes: {},          // postId -> token[]
    galleryOrder: null, // shuffled post ids (全員同じ並び)
    results: null,
    graceTimers: new Map(), // token -> Timeout（投票猶予タイマー）
  };
}
const roomOf = (code) => rooms.get(code);
const newCode = () => {
  let c;
  do { c = crypto.randomBytes(2).toString("hex").toUpperCase(); } while (rooms.has(c));
  return c;
};
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/* ---------- スナップショット（クライアントへの公開状態） ---------- */
function snapshotFor(room, token) {
  const me = room.players.get(token);
  const players = [...room.players.values()].map((p) => ({
    name: p.name,
    connected: !!p.socketId,
    left: !!p.left,
    done: room.phase === "voting"
      ? (!!p.votedIds || !!p.skipped || !!p.left)
      : (!!p.doneRound || !!p.left),
  }));
  const base = {
    code: room.code,
    phase: room.phase,
    theme: room.theme,
    postingSeconds: room.postingSeconds,
    postingEndsAt: room.postingEndsAt,
    players,
    you: me ? { name: me.name, isHost: isHost(room, token) } : null,
    recommended: RECOMMENDED_PLAYERS,
  };

  if (room.phase === "posting" && me) {
    base.myPosts = me.posts.map((p) => ({ id: p.id, text: p.text }));
    base.totalThrown = totalPosts(room);
  }
  if (room.phase === "collect") {
    base.totalThrown = totalPosts(room);
  }
  if (room.phase === "gallery" || room.phase === "voting") {
    base.posts = publicPosts(room, token); // 匿名・共通順
    base.distribution = distribution(room);
    if (room.phase === "voting" && me) {
      base.allotment = allotmentFor(room, token);
      base.voted = !!me.votedIds;
      base.skipped = !!me.skipped;
      base.lowPostWarning = lowPostWarning(room);
    }
  }
  if (room.phase === "results") {
    base.results = room.results;
  }
  return base;
}
const isHost = (room, token) => room.hostToken === token;
// ホストが切断/離脱したら、接続中かつ left でない最初のプレイヤーへ移譲（戻さない）
function reassignHostIfNeeded(room) {
  const h = room.players.get(room.hostToken);
  if (h && h.socketId && !h.left) return;
  for (const [tk, p] of room.players) {
    if (p.socketId && !p.left) { room.hostToken = tk; return; }
  }
}
// 投稿フェーズ完了判定: 全員が done / left / 切断中なら完了扱い
function postingComplete(room) {
  return [...room.players.values()].every((p) => p.doneRound || p.left || !p.socketId);
}
function clearVoteGrace(room, token) {
  const t = room.graceTimers.get(token);
  if (t) { clearTimeout(t); room.graceTimers.delete(token); }
}
function startVoteGrace(room, token) {
  if (room.graceTimers.has(token)) return;
  const t = setTimeout(() => {
    room.graceTimers.delete(token);
    const p = room.players.get(token);
    if (!p || room.phase !== "voting" || p.votedIds || p.skipped) return;
    p.skipped = true;
    broadcastState(room);
    maybeFinishVoting(room);
  }, VOTE_GRACE_MS);
  room.graceTimers.set(token, t);
}
const totalPosts = (room) =>
  [...room.players.values()].reduce((s, p) => s + p.posts.length, 0);

function publicPosts(room, token) {
  // gallery で固定した共通シャッフル順。匿名。自分の投稿だけ mine フラグ。
  if (!room.galleryOrder) {
    const all = [];
    room.players.forEach((p, t) => p.posts.forEach((po) => all.push({ id: po.id, text: po.text, owner: t })));
    room.galleryOrder = shuffle(all);
  }
  return room.galleryOrder.map((po) => ({ id: po.id, text: po.text, mine: po.owner === token }));
}
function distribution(room) {
  const c = {};
  room.players.forEach((p) => { c[p.posts.length] = (c[p.posts.length] || 0) + 1; });
  return Object.entries(c)
    .map(([k, v]) => ({ posts: +k, people: v }))
    .sort((a, b) => b.posts - a.posts);
}
function allotmentFor(room, token) {
  const others = totalPosts(room) - room.players.get(token).posts.length;
  return voteAllotment(room.players.size, others);
}
function lowPostWarning(room) {
  // §9-4: 投稿総数が「最大持ち票+1」未満なら警告（強制中断はしない）
  const maxAllot = Math.min(Math.max(room.players.size - 2, 0), 5);
  return totalPosts(room) < maxAllot + 1;
}
function broadcastState(room) {
  room.players.forEach((p, token) => {
    if (p.socketId) io.to(p.socketId).emit("room:state", snapshotFor(room, token));
  });
}

/* ---------- フェーズ遷移 ---------- */
async function startPosting(room) {
  room.theme = await generateTheme(room.code, room.themeHistory);
  room.themeHistory.push(room.theme);
  // 離脱者は新しい試合の開始時に room から削除し、待ち判定の対象外にする
  room.graceTimers.forEach((t) => clearTimeout(t));
  room.graceTimers.clear();
  [...room.players.entries()].forEach(([tk, p]) => { if (p.left) room.players.delete(tk); });
  reassignHostIfNeeded(room);
  room.players.forEach((p) => {
    p.posts = []; p.doneRound = false; p.votedIds = null; p.skipped = false;
  });
  room.votes = {};
  room.galleryOrder = null;
  room.results = null;
  room.phase = "posting";
  room.postingEndsAt =
    room.postingSeconds > 0 ? Date.now() + room.postingSeconds * 1000 : null;
  clearTimeout(room.postingTimer);
  if (room.postingEndsAt) {
    room.postingTimer = setTimeout(() => endPosting(room), room.postingSeconds * 1000 + 250);
  }
  broadcastState(room);
}
function endPosting(room) {
  if (room.phase !== "posting") return;
  clearTimeout(room.postingTimer);
  room.phase = "collect";
  room.postingEndsAt = null;
  broadcastState(room);
  // 集約演出: 全員同時に再生 → 終了後 gallery へ自動遷移（全員同じタイミング）
  const dur = totalPosts(room) * COLLECT_MS_PER_PAPER + 1600;
  setTimeout(() => {
    if (room.phase !== "collect") return;
    room.phase = "gallery";
    broadcastState(room);
  }, Math.min(dur, 15000));
}
function maybeFinishVoting(room) {
  const allVoted = [...room.players.values()].every(
    (p) => p.votedIds || p.skipped || p.left || allotmentFor(room, p.token) === 0
  );
  if (!allVoted) return;
  // 投票猶予タイマーが残っていれば全解除
  room.graceTimers.forEach((t) => clearTimeout(t));
  room.graceTimers.clear();
  // 採点（サーバ側・仕様 §4）
  const players = [...room.players.entries()].map(([token, p]) => ({
    id: token, name: p.name, postIds: p.posts.map((x) => x.id),
  }));
  // 実際に投票したプレイヤーのみを「全員」の母数にする（スキップ/離脱は除外）
  const voterIds = [...room.players.entries()]
    .filter(([, p]) => Array.isArray(p.votedIds))
    .map(([tk]) => tk);
  const rows = computeResults(players, room.votes, voterIds);
  const voteCount = {};
  Object.entries(room.votes).forEach(([id, v]) => (voteCount[id] = v.length));
  // 累積スコア: ラウンド採点確定時に final を加算（id=token で対応付け）
  rows.forEach((r) => {
    const p = room.players.get(r.id);
    if (p) p.cumulative += r.final;
  });
  const standings = [...room.players.values()]
    .map((p) => {
      const r = rows.find((x) => x.id === p.token);
      return { name: p.name, roundPts: r ? r.final : 0, cumulative: p.cumulative };
    })
    .sort((a, b) => b.cumulative - a.cumulative);
  room.results = {
    table: rows.map((r) => ({
      name: r.name, rank: r.rank, postCount: r.postCount,
      total: r.total, rankPts: r.rankPts, final: r.final, tags: r.tags,
    })),
    matchInfo: {
      current: room.currentMatch,
      total: room.totalMatches,
      isFinal: room.currentMatch === room.totalMatches,
      standings,
    },
    reveal: REVEAL_AUTHORS_IN_RESULTS
      ? (room.galleryOrder || []).map((po) => ({
          text: po.text,
          author: room.players.get(po.owner)?.name || "?",
          votes: voteCount[po.id] || 0,
        }))
      : null,
  };
  room.phase = "results";
  broadcastState(room);
  persistence.saveRound(room.code, room.theme, rows);
}

/* ---------- Socket.io ---------- */
io.on("connection", (socket) => {
  let myRoom = null;
  let myToken = null;

  socket.on("room:create", ({ name }, cb) => {
    const code = newCode();
    const room = makeRoom(code);
    rooms.set(code, room);
    join(room, name, cb);
  });

  socket.on("room:join", ({ code, name, token }, cb) => {
    const room = roomOf((code || "").toUpperCase());
    if (!room) return cb({ error: "ルームが見つかりません" });
    // 再接続（トークン復帰）
    if (token && room.players.has(token)) {
      const p = room.players.get(token);
      p.socketId = socket.id;
      clearVoteGrace(room, token); // 再接続したら投票猶予を解除
      myRoom = room; myToken = token;
      socket.join(room.code);
      cb({ ok: true, token, snapshot: snapshotFor(room, token) });
      broadcastState(room);
      return;
    }
    if (room.phase !== "lobby") return cb({ error: "ゲーム進行中のため参加できません" });
    if (room.players.size >= MAX_PLAYERS) return cb({ error: "満員です" });
    join(room, name, cb);
  });

  function join(room, name, cb) {
    const clean = String(name || "").trim().slice(0, 12);
    if (!clean) return cb({ error: "名前を入力してください" });
    if ([...room.players.values()].some((p) => p.name === clean))
      return cb({ error: "同じ名前の参加者がいます" });
    const token = crypto.randomBytes(12).toString("hex");
    room.players.set(token, {
      token, name: clean, socketId: socket.id, posts: [], doneRound: false,
      votedIds: null, left: false, skipped: false, cumulative: 0,
    });
    if (!room.hostToken) room.hostToken = token; // 最初の参加者がホスト
    myRoom = room; myToken = token;
    socket.join(room.code);
    cb({ ok: true, token, snapshot: snapshotFor(room, token) });
    broadcastState(room);
  }

  socket.on("game:start", ({ seconds, matches }) => {
    const room = myRoom;
    if (!room || !isHost(room, myToken) || room.phase !== "lobby") return;
    if (room.players.size < MIN_PLAYERS) return;
    if ([30, 60, 120, 0].includes(seconds)) room.postingSeconds = seconds;
    // 試合数: 妥当な範囲(1〜10)の整数のみ受理。範囲外・不正値は既定3にフォールバック。
    // UIのプリセット(1/3/5)とは独立 — サーバは「妥当な整数」だけを保証する。
    room.totalMatches = (Number.isInteger(matches) && matches >= 1 && matches <= 10) ? matches : 3;
    room.currentMatch = 1;
    room.players.forEach((p) => { p.cumulative = 0; });
    startPosting(room);
  });

  // 投稿（1件ずつ即時確定 — 仕様 §3②）。全員に同期投函イベント（§5.2）。
  socket.on("post:add", ({ text }, cb) => {
    const room = myRoom;
    if (!room || room.phase !== "posting") return cb && cb({ error: "投稿フェーズではありません" });
    const me = room.players.get(myToken);
    const clean = String(text || "").trim().slice(0, 60);
    if (!clean) return cb && cb({ error: "本文が空です" });
    const post = { id: "p" + postSeq++, text: clean };
    me.posts.push(post);
    cb && cb({ ok: true, post });
    // ★同期演出: 投稿者・本文は伏せ、「1枚投函された」事実だけを全員へ
    io.to(room.code).emit("post:thrown", { total: totalPosts(room) });
  });

  socket.on("post:done", () => {
    const room = myRoom;
    if (!room || room.phase !== "posting") return;
    room.players.get(myToken).doneRound = true;
    broadcastState(room);
    if (postingComplete(room)) endPosting(room);
  });

  socket.on("gallery:next", () => {
    const room = myRoom;
    if (!room || !isHost(room, myToken) || room.phase !== "gallery") return;
    room.players.forEach((p) => (p.doneRound = false));
    room.phase = "voting";
    // 持ち票0のプレイヤーは投票対象なし → 自動スキップ
    room.players.forEach((p, tk) => {
      p.skipped = allotmentFor(room, tk) === 0;
    });
    broadcastState(room);
    // 切断中/離脱のプレイヤーには猶予タイマーを開始
    room.players.forEach((p, tk) => {
      if (!p.skipped && !p.votedIds && (!p.socketId || p.left)) startVoteGrace(room, tk);
    });
    maybeFinishVoting(room); // 全員スキップ/離脱なら即終了
  });

  // 投票（複数選択 → 一括確定。サーバ側で全制約を検証 — 仕様 §3⑤）
  socket.on("vote:submit", ({ postIds }, cb) => {
    const room = myRoom;
    if (!room || room.phase !== "voting") return cb({ error: "投票フェーズではありません" });
    const me = room.players.get(myToken);
    if (me.votedIds) return cb({ error: "投票済みです" });
    const need = allotmentFor(room, myToken);
    const ids = [...new Set(postIds || [])];
    if (ids.length !== need) return cb({ error: `${need}票ちょうど必要です` });
    const myIds = new Set(me.posts.map((p) => p.id));
    const validIds = new Set((room.galleryOrder || []).map((p) => p.id));
    for (const id of ids) {
      if (!validIds.has(id)) return cb({ error: "不正な投稿IDです" });
      if (myIds.has(id)) return cb({ error: "自分の投稿には投票できません" });
    }
    me.votedIds = ids;
    clearVoteGrace(room, myToken);
    ids.forEach((id) => { (room.votes[id] = room.votes[id] || []).push(myToken); });
    cb({ ok: true });
    // 同期演出: 誰かが投票を確定するたび全員の箱に投函
    io.to(room.code).emit("vote:cast", {
      voted: [...room.players.values()].filter((p) => p.votedIds).length,
      total: room.players.size,
    });
    broadcastState(room);
    maybeFinishVoting(room);
  });

  socket.on("game:again", () => {
    const room = myRoom;
    if (!room || !isHost(room, myToken) || room.phase !== "results") return;
    if (room.currentMatch >= room.totalMatches) return; // 最終戦後は次へ進めない
    room.currentMatch++;
    startPosting(room);
  });

  // 最終戦終了後、同じメンバーでもう一度（累積リセット → ロビーへ戻り試合数を再選択）
  socket.on("game:rematch", () => {
    const room = myRoom;
    if (!room || !isHost(room, myToken) || room.phase !== "results") return;
    if (room.currentMatch !== room.totalMatches) return; // isFinal のときのみ
    // 離脱者を除去してホストを再確定
    room.graceTimers.forEach((t) => clearTimeout(t));
    room.graceTimers.clear();
    [...room.players.entries()].forEach(([tk, p]) => { if (p.left) room.players.delete(tk); });
    reassignHostIfNeeded(room);
    room.players.forEach((p) => { p.cumulative = 0; p.skipped = false; p.votedIds = null; p.doneRound = false; });
    room.currentMatch = 1;
    room.phase = "lobby";
    room.theme = null;
    room.results = null;
    room.galleryOrder = null;
    broadcastState(room);
  });

  // ルーム解散（ホストのみ）。全クライアントへ room:closed を通知してルーム削除。
  socket.on("room:disband", () => {
    const room = myRoom;
    if (!room || !isHost(room, myToken)) return;
    io.to(room.code).emit("room:closed");
    clearTimeout(room.postingTimer);
    rooms.delete(room.code);
  });

  // キック（ホストのみ）。ロビー中は削除、ゲーム中は left 扱いで待ちから外す。
  socket.on("player:kick", ({ targetName }) => {
    const room = myRoom;
    if (!room || !isHost(room, myToken)) return;
    let targetTk = null, target = null;
    for (const [tk, p] of room.players) {
      if (p.name === targetName) { targetTk = tk; target = p; break; }
    }
    if (!target || targetTk === room.hostToken) return; // 自分(ホスト)は対象外
    const sid = target.socketId;
    if (room.phase === "lobby") {
      room.players.delete(targetTk);
    } else {
      target.left = true; // 投稿/投票の待ちから外す（既存の投稿・票は有効のまま）
      clearVoteGrace(room, targetTk);
    }
    if (sid) io.to(sid).emit("room:kicked");
    broadcastState(room);
    // キックで詰みが解ける場合に備えて再評価
    if (room.phase === "posting" && postingComplete(room)) endPosting(room);
    if (room.phase === "voting") maybeFinishVoting(room);
  });

  socket.on("disconnect", () => {
    const room = myRoom;
    if (!room) return;
    const me = room.players.get(myToken);
    if (me) me.socketId = null;
    // ロビー中の切断は離脱扱い（room から削除）
    if (room.phase === "lobby" && me) room.players.delete(myToken);
    // ホストが切断/離脱したら移譲
    reassignHostIfNeeded(room);
    // 接続中プレイヤーが0になったらルーム削除
    const connected = [...room.players.values()].filter((p) => p.socketId).length;
    if (connected === 0) {
      clearTimeout(room.postingTimer);
      room.graceTimers.forEach((t) => clearTimeout(t));
      room.graceTimers.clear();
      rooms.delete(room.code);
      return;
    }
    // 投票中の切断 → 猶予タイマー開始
    if (room.phase === "voting" && me && !me.votedIds && !me.skipped && !me.left) {
      startVoteGrace(room, myToken);
    }
    broadcastState(room);
    // 投稿フェーズ: 残り全員が完了/離脱/切断なら締める
    if (room.phase === "posting" && postingComplete(room)) endPosting(room);
    // 投票フェーズ: 切断で残り全員が完了相当になったら締める
    if (room.phase === "voting") maybeFinishVoting(room);
  });
});

persistence.init().then(() => {
  server.listen(PORT, () => console.log(`あるある選挙 server on :${PORT}`));
});
