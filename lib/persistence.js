"use strict";
/**
 * Supabase 永続化アダプタ（任意）
 * SUPABASE_URL / SUPABASE_SERVICE_KEY が設定されているときだけ動く。
 * 未設定ならすべて no-op（MVPはインメモリで完結する設計）。
 *
 * 想定テーブル（README参照）:
 *   rounds(id, room_code, theme, player_count, created_at)
 *   round_results(round_id, player_name, post_count, total_votes, rank, final_pts, tags jsonb)
 */
let client = null;

async function init() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    const { createClient } = require("@supabase/supabase-js");
    client = createClient(url, key);
    console.log("[supabase] persistence enabled");
  } catch {
    console.warn("[supabase] @supabase/supabase-js 未インストールのため無効化");
  }
}

async function saveRound(roomCode, theme, results) {
  if (!client) return;
  try {
    const { data, error } = await client
      .from("rounds")
      .insert({ room_code: roomCode, theme, player_count: results.length })
      .select("id")
      .single();
    if (error) throw error;
    await client.from("round_results").insert(
      results.map((r) => ({
        round_id: data.id,
        player_name: r.name,
        post_count: r.postCount,
        total_votes: r.total,
        rank: r.rank,
        final_pts: r.final,
        tags: r.tags,
      }))
    );
  } catch (e) {
    console.warn("[supabase] save failed:", e.message);
  }
}

module.exports = { init, saveRound };
