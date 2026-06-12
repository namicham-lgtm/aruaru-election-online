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
    postingSeconds: 120,
    postingEndsAt: null,
    postingTimer: null,
    players: new Map(), // token -> {token, name, socketId|null, posts:[{id,text}], doneRound, votedIds|null}
    votes: {},          // postId -> token[]
    galleryOrder: null, // shuffled post ids (全員同じ並び)
    results: null,
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
    done: room.phase === "voting" ? !!p.votedIds : !!p.doneRound,
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
      base.lowPostWarning = lowPostWarning(room);
    }
  }
  if (room.phase === "results") {
    base.results = room.results;
  }
  return base;
}
const isHost = (room, token) => [...room.players.keys()][0] === token;
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
  room.players.forEach((p) => { p.posts = []; p.doneRound = false; p.votedIds = null; });
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
    (p) => p.votedIds || allotmentFor(room, p.token) === 0
  );
  if (!allVoted) return;
  // 採点（サーバ側・仕様 §4）
  const players = [...room.players.entries()].map(([token, p]) => ({
    id: token, name: p.name, postIds: p.posts.map((x) => x.id),
  }));
  const rows = computeResults(players, room.votes);
  const voteCount = {};
  Object.entries(room.votes).forEach(([id, v]) => (voteCount[id] = v.length));
  room.results = {
    table: rows.map((r) => ({
      name: r.name, rank: r.rank, postCount: r.postCount,
      total: r.total, rankPts: r.rankPts, final: r.final, tags: r.tags,
    })),
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
      token, name: clean, socketId: socket.id, posts: [], doneRound: false, votedIds: null,
    });
    myRoom = room; myToken = token;
    socket.join(room.code);
    cb({ ok: true, token, snapshot: snapshotFor(room, token) });
    broadcastState(room);
  }

  socket.on("game:start", ({ seconds }) => {
    const room = myRoom;
    if (!room || !isHost(room, myToken) || room.phase !== "lobby") return;
    if (room.players.size < MIN_PLAYERS) return;
    if ([30, 60, 120, 0].includes(seconds)) room.postingSeconds = seconds;
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
    if ([...room.players.values()].every((p) => p.doneRound)) endPosting(room);
  });

  socket.on("gallery:next", () => {
    const room = myRoom;
    if (!room || !isHost(room, myToken) || room.phase !== "gallery") return;
    room.players.forEach((p) => (p.doneRound = false));
    room.phase = "voting";
    broadcastState(room);
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
    startPosting(room);
  });

  socket.on("disconnect", () => {
    const room = myRoom;
    if (!room) return;
    const me = room.players.get(myToken);
    if (me) me.socketId = null;
    // ロビー中の切断は離脱扱い
    if (room.phase === "lobby" && me) room.players.delete(myToken);
    if (room.players.size === 0) {
      clearTimeout(room.postingTimer);
      rooms.delete(room.code);
      return;
    }
    broadcastState(room);
  });
});

persistence.init().then(() => {
  server.listen(PORT, () => console.log(`あるある選挙 server on :${PORT}`));
});
