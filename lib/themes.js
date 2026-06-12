"use strict";
/**
 * お題生成（仕様 §3①）
 * ANTHROPIC_API_KEY があれば Claude API で動的生成、なければ組み込みリスト。
 * 「一段具体的なテーマのほうが面白い」傾向(仕様の発展案)をプロンプトに反映。
 */
const FALLBACK = [
  "学校", "テスト返却", "体育の授業", "バイトの初日", "コンビニ深夜帯",
  "満員電車", "家族旅行", "結婚式の余興", "温泉旅館", "健康診断",
  "一人暮らしの夜", "居酒屋の一杯目", "美容院の会話", "ネット通販の罠",
  "雨の日の通学", "正月の親戚", "ジム入会1ヶ月目", "ファミレスの長居",
  "推し活の遠征", "在宅ワーク", "歯医者の待合室", "引っ越し前日",
];

const usedPerRoom = new Map(); // roomCode -> Set<theme>

function fallbackTheme(roomCode) {
  const used = usedPerRoom.get(roomCode) || new Set();
  const pool = FALLBACK.filter((t) => !used.has(t));
  const pick = (pool.length ? pool : FALLBACK)[
    Math.floor(Math.random() * (pool.length ? pool.length : FALLBACK.length))
  ];
  used.add(pick);
  usedPerRoom.set(roomCode, used);
  return pick;
}

async function generateTheme(roomCode, prevThemes = []) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallbackTheme(roomCode);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.THEME_MODEL || "claude-fable-5",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content:
              `「あるある」大喜利のお題を1つだけ生成してください。` +
              `広すぎるテーマ（例:「学校」）より一段具体的なシチュエーション（例:「テスト返却」「体育の授業」）が望ましい。` +
              `日本語で12文字以内。お題のみを出力し、説明や記号は付けない。` +
              (prevThemes.length ? `既出: ${prevThemes.join("、")}（重複禁止）` : ""),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error("API " + res.status);
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .replace(/[「」。\s]/g, "");
    return text && text.length <= 20 ? text : fallbackTheme(roomCode);
  } catch {
    return fallbackTheme(roomCode);
  }
}

module.exports = { generateTheme };
