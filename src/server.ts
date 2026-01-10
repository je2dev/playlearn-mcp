// server.ts
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// MCP SDK (HTTP/SSE)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/* ----------------------------- ENV / SUPABASE ----------------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ---------------------------------- Zod ---------------------------------- */
const ModeEnum = z.enum(["toeic", "grammar", "travel", "business", "vocab"]);
type Mode = z.infer<typeof ModeEnum>;

const SignalEnum = z.enum(["hard", "easy", "neutral"]).optional();

const GetQuestionArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional (중복문제 방지 + pending 저장)
  mode: ModeEnum,
  level: z.number().int().min(1).max(10),
});

const SubmitAnswerArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

const SaveItemArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  item_type: z.enum(["vocab", "mistake", "note"]),
  key: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional().default({}), // ✅ payload 없어도 되게
});

const GetReviewItemsArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  limit: z.number().int().min(1).max(50).default(5),
  item_type: z.enum(["vocab", "mistake", "note"]).optional(),
});

const GetLearningSummaryArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  days: z.number().int().min(1).max(365).default(7),
});

// 진단 관련
const GetUserStateArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
});

const PlacementStartArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  mode: ModeEnum,
});

const PlacementSubmitArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  placement_id: z.string().uuid(),
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

// ✅ 채팅 오케스트레이터
const HandleUserMessageArgs = z.object({
  user_id: z.string().min(1).optional(),
  message: z.string().min(1),
});

/* -------------------------------- Helpers -------------------------------- */

// ✅ user_id가 없으면 공통 ID로 대체 (카카오 데모용)
function resolveUserId(raw: unknown): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return "kakao_default";
}

async function ensureUser(user_id: string, mode?: Mode) {
  const { data, error } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw error;
  if (data) return;

  const lastMode: Mode = mode ?? "toeic";

  const { error: insErr } = await supabase.from("users").insert({
    user_id,
    current_level: 3,
    exp_points: 0,
    placement_done: false,
    last_mode: lastMode,
  });

  if (insErr) throw insErr;
}

function safeErrorText(e: unknown) {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function mustAcceptSseAndJson(req: Request) {
  const accept = String(req.headers["accept"] ?? "");
  return accept.includes("text/event-stream") && accept.includes("application/json");
}

function safeJsonRpcError(res: Response, message = "Internal Server Error") {
  res.status(500).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

// 선택지 채점 헬퍼 (1/A/B/C/D 다 처리)
function gradeAnswer(opts: { choices: string[]; correctAnswer: unknown; userAnswer: string }) {
  const { choices } = opts;

  const raw = String(opts.userAnswer ?? "").trim();
  const upper = raw.toUpperCase();

  const alphaMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

  let userPickIndex: number | null = null;

  // 숫자(1,2,3,4..)
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) userPickIndex = n - 1;
  }

  // 알파벳(A,B,C,D..)
  if (upper in alphaMap) userPickIndex = alphaMap[upper];

  const userPickValue =
    userPickIndex !== null && choices[userPickIndex] != null
      ? String(choices[userPickIndex]).trim()
      : raw;

  const ansStr = String(opts.correctAnswer ?? "").trim();
  const ansUpper = ansStr.toUpperCase();

  // 정답이 "1","2"처럼 숫자 인덱스인 경우
  if (/^\d+$/.test(ansStr) && userPickIndex !== null) {
    const ansIndex = Number(ansStr) - 1;
    return { isCorrect: ansIndex === userPickIndex, raw, userPickIndex, userPickValue, ansStr };
  }

  // 정답이 "A","B"처럼 알파벳인 경우
  if (ansStr.length === 1 && ansUpper in alphaMap && userPickIndex !== null) {
    return { isCorrect: alphaMap[ansUpper] === userPickIndex, raw, userPickIndex, userPickValue, ansStr };
  }

  // 그 외에는 텍스트 비교
  const isCorrect =
    userPickValue.trim().toUpperCase() === ansUpper || raw.trim().toUpperCase() === ansUpper;

  return { isCorrect, raw, userPickIndex, userPickValue, ansStr };
}

function modeKo(mode: Mode): string {
  switch (mode) {
    case "toeic":
      return "토익";
    case "grammar":
      return "문법";
    case "travel":
      return "여행";
    case "business":
      return "비즈니스";
    case "vocab":
      return "단어";
  }
}

function parseModeFromMessage(msg: string): Mode | null {
  const m = msg.trim().toLowerCase();

  if (m.includes("토익") || m.includes("toeic")) return "toeic";
  if (m.includes("문법") || m.includes("grammar")) return "grammar";
  if (m.includes("여행") || m.includes("travel")) return "travel";
  if (m.includes("비즈니스") || m.includes("business")) return "business";
  if (m.includes("단어") || m.includes("어휘") || m.includes("vocab")) return "vocab";
  return null;
}

function isEasySignal(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m.includes("쉬워") || m.includes("쉽") || m === "easy";
}

function isHardSignal(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m.includes("어려") || m.includes("어렵") || m === "hard";
}

function isNext(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m === "다음" || m === "계속" || m === "gogo" || m.includes("ㄱㄱ");
}

function isStop(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m === "그만" || m === "종료" || m === "끝" || m.includes("그만할래");
}

function isSummary(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m.includes("요약") || m.includes("정리") || m.includes("오늘공부") || m.includes("오늘공부한내용");
}

function isMistakeNote(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m.includes("오답노트") || (m.includes("오답") && (m.includes("정리") || m.includes("보여") || m.includes("내놔")));
}

function isAnswerToken(msg: string) {
  const t = msg.trim();
  return /^[1-9]\d*$/.test(t) || /^[a-eA-E]$/.test(t);
}

/* ----------------------------- KST Day Range ------------------------------ */
function getKstDayRangeISO(now = new Date()) {
  // KST = UTC+9
  const utcMs = now.getTime();
  const kstMs = utcMs + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);

  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();

  const startKstMs = Date.UTC(y, m, d, 0, 0, 0);
  const endKstMs = Date.UTC(y, m, d + 1, 0, 0, 0);

  const startUtcMs = startKstMs - 9 * 60 * 60 * 1000;
  const endUtcMs = endKstMs - 9 * 60 * 60 * 1000;

  return {
    startISO: new Date(startUtcMs).toISOString(),
    endISO: new Date(endUtcMs).toISOString(),
  };
}

/* --------------------------- Duplicate Avoidance -------------------------- */
async function getRecentAttemptedQids(opts: { user_id: string; mode?: Mode; limit?: number }) {
  const limit = opts.limit ?? 50;
  let q = supabase
    .from("study_logs")
    .select("q_id, created_at, mode")
    .eq("user_id", opts.user_id)
    .in("event_type", ["quiz_attempt", "placement_attempt"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts.mode) q = q.eq("mode", opts.mode);

  const { data, error } = await q;
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => String(r.q_id)));
}

async function pickRandomQuestionAvoiding(mode: Mode, level: number, excludeQids?: Set<string>) {
  const { data, error } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true)
    .limit(80);

  if (error) throw error;
  const list = (data ?? []) as any[];
  if (list.length === 0) return null;

  const filtered = excludeQids ? list.filter((x) => !excludeQids.has(String(x.q_id))) : list;
  const pool = filtered.length > 0 ? filtered : list; // 다 막히면 그냥 pool fallback

  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] as any;
}

function formatChoicesWithNumbers(choices: string[]) {
  // ✅ 항상 "1. A. ..." 형태가 나오게
  return choices.length ? choices.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)";
}

/* ------------------------------ One-time UX ------------------------------- */
// ✅ “난이도 어때요?” 안내를 계속 반복하지 않기 위해 서버 메모리에 1회만 띄움
const difficultyNudgeShown = new Map<string, number>(); // user_id -> timestamp(ms)
const DIFF_NUDGE_TTL = 1000 * 60 * 60 * 12; // 12시간 내에는 다시 안 띄움

function shouldShowDifficultyNudge(user_id: string) {
  const now = Date.now();
  const last = difficultyNudgeShown.get(user_id) ?? 0;
  if (now - last > DIFF_NUDGE_TTL) {
    difficultyNudgeShown.set(user_id, now);
    return true;
  }
  return false;
}

/* ------------------------------- Pending Q ------------------------------- */
// ✅ 채팅형: “답만 보내면 채점” 되도록 마지막으로 낸 문제 기억
type Pending = { q_id: string; mode: Mode; level: number; sent_at: string };
const pendingByUser = new Map<string, Pending>();

/* ------------------------ Level Clear / Promotion ------------------------- */
async function getConsecutiveCorrectAtLevel(opts: { user_id: string; mode: Mode; level: number; limit?: number }) {
  const limit = opts.limit ?? 20;
  const { data, error } = await supabase
    .from("study_logs")
    .select("is_correct, level, created_at")
    .eq("user_id", opts.user_id)
    .eq("event_type", "quiz_attempt")
    .eq("mode", opts.mode)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  let streak = 0;
  for (const row of data ?? []) {
    if (Number(row.level) !== opts.level) break;
    if (row.is_correct === true) streak += 1;
    else break;
  }
  return streak;
}

const awaitingPromotionDecision = new Map<string, { mode: Mode; fromLevel: number; askedAt: number }>();
function isPromotionYes(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m === "올려" || m === "올려줘" || m.includes("다음레벨") || m.includes("올릴까") || m.includes("올려요") || m === "y";
}
function isPromotionNo(msg: string) {
  const m = msg.replace(/\s+/g, "");
  return m === "유지" || m.includes("그대로") || m.includes("아니") || m === "n";
}

/* ----------------------------- Auto Save Mistake -------------------------- */
async function autoSaveMistake(opts: {
  user_id: string;
  q: any;
  graded: ReturnType<typeof gradeAnswer>;
  user_answer: string;
}) {
  if (opts.graded.isCorrect) return;

  const item_id = randomUUID();
  const key = String(opts.q.q_id);

  const payload = {
    mode: opts.q.mode,
    level: opts.q.level,
    prompt: opts.q.prompt,
    choices: opts.q.choices ?? [],
    correct_answer: String(opts.q.answer ?? ""),
    explanation: opts.q.explanation ?? null,
    user_answer: opts.graded.userPickValue ?? opts.graded.raw ?? opts.user_answer,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("review_items").insert({
    item_id,
    user_id: opts.user_id,
    item_type: "mistake",
    key,
    payload,
    strength: 1,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });

  // 중복 저장/제약 에러 등은 학습 흐름을 깨지 않도록 무시(로그만)
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[autoSaveMistake] failed:", error.message);
  }
}

/* --------------------------- Today Summary Builder ------------------------ */
async function buildTodayFullSummary(user_id: string) {
  const { startISO, endISO } = getKstDayRangeISO(new Date());

  const { data: logs, error: lErr } = await supabase
    .from("study_logs")
    .select("q_id, mode, level, is_correct, user_answer, created_at")
    .eq("user_id", user_id)
    .eq("event_type", "quiz_attempt")
    .gte("created_at", startISO)
    .lt("created_at", endISO)
    .order("created_at", { ascending: true });

  if (lErr) throw lErr;

  const rows = logs ?? [];
  if (rows.length === 0) {
    return "오늘 푼 문제가 아직 없어요. \"다음\"이라고 보내면 바로 시작할게요.";
  }

  const qids = Array.from(new Set(rows.map((r: any) => String(r.q_id))));
  const { data: qs, error: qErr } = await supabase
    .from("questions")
    .select("q_id, prompt, choices, answer, explanation, mode, level, media")
    .in("q_id", qids);

  if (qErr) throw qErr;
  const qMap = new Map<string, any>((qs ?? []).map((q: any) => [String(q.q_id), q]));

  let out = `📌 오늘 학습 정리 (문제+정답+해설)\n`;
  out += `- 총 ${rows.length}문제\n\n`;

  rows.forEach((r: any, idx: number) => {
    const q = qMap.get(String(r.q_id));
    if (!q) return;
    const choices = (q.choices ?? []) as string[];
    const mediaMd = q.media?.image ? `\n![image](${q.media.image})\n` : "";
    out += `#${idx + 1}) ${modeKo(q.mode)} Lv.${q.level}\n`;
    out += `${q.prompt}${mediaMd}\n\n`;
    out += `${formatChoicesWithNumbers(choices)}\n\n`;
    out += `- 내 답: ${String(r.user_answer ?? "").trim()}\n`;
    out += `- 결과: ${r.is_correct ? "✅ 정답" : "❌ 오답"}\n`;
    out += `- 정답: ${String(q.answer ?? "").trim()}\n`;
    out += `- 해설: ${q.explanation ?? "(해설 없음)"}\n`;
    out += `\n---\n\n`;
  });

  out += `원하면 "오답노트"라고 보내면 오늘 틀린 것만 모아서 + 바로 복습문제까지 이어서 줄게요.`;
  return out;
}

async function buildTodayMistakeNoteWithReview(user_id: string) {
  const { startISO, endISO } = getKstDayRangeISO(new Date());

  const { data: logs, error: lErr } = await supabase
    .from("study_logs")
    .select("q_id, mode, level, is_correct, user_answer, created_at")
    .eq("user_id", user_id)
    .eq("event_type", "quiz_attempt")
    .eq("is_correct", false)
    .gte("created_at", startISO)
    .lt("created_at", endISO)
    .order("created_at", { ascending: true });

  if (lErr) throw lErr;

  const wrongRows = logs ?? [];
  if (wrongRows.length === 0) {
    return `✅ 오늘 오답이 없어요.\n\n원하면 "다음"으로 계속 풀거나, "정리"로 오늘 푼 문제 전체를 묶어서 볼 수 있어요.`;
  }

  const qids = Array.from(new Set(wrongRows.map((r: any) => String(r.q_id))));
  const { data: qs, error: qErr } = await supabase
    .from("questions")
    .select("q_id, prompt, choices, answer, explanation, mode, level, media")
    .in("q_id", qids);

  if (qErr) throw qErr;
  const qMap = new Map<string, any>((qs ?? []).map((q: any) => [String(q.q_id), q]));

  let out = `🧾 오늘 오답노트 (문제+정답+해설)\n`;
  out += `- 오답 ${wrongRows.length}개\n\n`;

  // 오답 정리
  wrongRows.forEach((r: any, idx: number) => {
    const q = qMap.get(String(r.q_id));
    if (!q) return;
    const choices = (q.choices ?? []) as string[];
    const mediaMd = q.media?.image ? `\n![image](${q.media.image})\n` : "";
    out += `#오답 ${idx + 1}) ${modeKo(q.mode)} Lv.${q.level}\n`;
    out += `${q.prompt}${mediaMd}\n\n`;
    out += `${formatChoicesWithNumbers(choices)}\n\n`;
    out += `- 내 답: ${String(r.user_answer ?? "").trim()}\n`;
    out += `- 정답: ${String(q.answer ?? "").trim()}\n`;
    out += `- 해설: ${q.explanation ?? "(해설 없음)"}\n`;
    out += `\n---\n\n`;
  });

  // ✅ 바로 복습문제(유사/대체)로 이어가기: 같은 mode/비슷한 level에서 “안 푼 문제” 랜덤 제공
  const first = wrongRows[0] as any;
  const mode = (first.mode ?? "toeic") as Mode;
  const baseLevel = Number(first.level ?? 3);

  const recent = await getRecentAttemptedQids({ user_id, mode, limit: 120 });
  const reviewQ1 = await pickRandomQuestionAvoiding(mode, Math.max(1, baseLevel), recent);
  if (!reviewQ1) {
    out += `✅ 복습 문제를 더 찾지 못했어요. (questions 테이블에 문제를 추가해 주세요)\n`;
    return out;
  }

  // pending 등록
  pendingByUser.set(user_id, { q_id: String(reviewQ1.q_id), mode: reviewQ1.mode, level: Number(reviewQ1.level), sent_at: new Date().toISOString() });

  const rChoices = (reviewQ1.choices ?? []) as string[];
  const mediaMd = reviewQ1.media?.image ? `\n\n![image](${reviewQ1.media.image})\n` : "";

  out += `🧪 복습 문제 (오늘 오답 기반 확인)\n`;
  out += `🧩 ${modeKo(reviewQ1.mode)} Lv.${reviewQ1.level}\n`;
  out += `${reviewQ1.prompt}${mediaMd}\n\n`;
  out += `${formatChoicesWithNumbers(rChoices)}\n\n`;
  out += `정답은 **숫자(1~)** 또는 **A~E** 로 보내 주세요.\n`;
  return out;
}

/* ----------------------------- Placement Config --------------------------- */
const PLACEMENT_QUESTION_COUNT = 5;

/* ------------------------------- MCP Server ------------------------------- */
const server = new McpServer({ name: "playlearn-mcp", version: "1.0.0" });

/* --------------------------- MCP: get_user_state --------------------------- */
server.tool(
  "get_user_state",
  "유저의 레벨/진단 여부 상태를 조회합니다.",
  { user_id: z.string().min(1).optional() },
  async (args) => {
    try {
      const parsed = GetUserStateArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      await ensureUser(user_id, "toeic");

      const { data, error } = await supabase
        .from("users")
        .select("user_id, current_level, placement_done, last_mode")
        .eq("user_id", user_id)
        .maybeSingle();

      if (error) throw error;

      const u = data as any;
      const payload = {
        exists: !!u,
        user_id,
        placement_done: !!u?.placement_done,
        current_level: Number(u?.current_level ?? 3),
        last_mode: u?.last_mode ?? null,
      };

      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `get_user_state 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* --------------------------- Tool: placement_start -------------------------- */
server.tool(
  "placement_start",
  "레벨 진단을 시작하고 placement_id와 첫 문제를 반환합니다. (총 5문제)",
  { user_id: z.string().min(1).optional(), mode: ModeEnum },
  async (args) => {
    try {
      const parsed = PlacementStartArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const mode = parsed.mode;
      await ensureUser(user_id, mode);

      // 유저 기본 레벨에서 시작
      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("current_level")
        .eq("user_id", user_id)
        .maybeSingle();
      if (uErr) throw uErr;

      const startLevel = Number((u as any)?.current_level ?? 3);

      const placement_id = randomUUID();

      // 첫 문제
      const recent = await getRecentAttemptedQids({ user_id, mode, limit: 80 });
      const q = await pickRandomQuestionAvoiding(mode, startLevel, recent);
      if (!q) {
        return { content: [{ type: "text", text: "진단용 문제를 찾지 못했습니다. questions 테이블에 문제를 추가해 주세요." }], isError: true };
      }

      // 세션 생성
      const newSession: any = {
        placement_id,
        user_id,
        mode,
        asked_count: 0,
        correct_count: 0,
        current_level: startLevel,
        last_q_id: q.q_id,
        is_done: false,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      };

      const { error: insErr } = await supabase.from("placement_sessions").insert(newSession);
      if (insErr) throw insErr;

      const choices = (q.choices ?? []) as string[];
      const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

      const text =
        `🧪 레벨 진단 시작! (총 ${PLACEMENT_QUESTION_COUNT}문제)\n` +
        `placement_id: \`${placement_id}\`\n\n` +
        `🧩 ${modeKo(q.mode)} Lv.${q.level}\n` +
        `${q.prompt}${mediaMd}\n\n` +
        `${formatChoicesWithNumbers(choices)}\n\n` +
        `정답은 **숫자(1~)** 또는 **A~E** 로 보내 주세요.\n` +
        `※ 진단 답안 제출 시 tool: placement_submit 을 사용하세요 (placement_id/q_id 필요).`;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_start 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* --------------------------- Tool: placement_submit -------------------------- */
server.tool(
  "placement_submit",
  "진단 답안을 채점하고 다음 문제 또는 최종 레벨 결과를 반환합니다. (총 5문제)",
  {
    user_id: z.string().min(1).optional(),
    placement_id: z.string().uuid(),
    q_id: z.string().uuid(),
    user_answer: z.string().min(1),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const parsed = PlacementSubmitArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const { placement_id, q_id, user_answer, signal } = parsed;

      await ensureUser(user_id, "toeic");

      // 1) 문제 조회
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices, prompt, media")
        .eq("q_id", q_id)
        .maybeSingle();
      if (qErr) throw qErr;
      if (!q) {
        return { content: [{ type: "text", text: "문제(q_id)를 찾지 못했습니다." }], isError: true };
      }

      const Q = q as any;
      const choices = (Q.choices ?? []) as string[];
      const mode = (Q.mode ?? "toeic") as Mode;
      let level = Number(Q.level ?? 3);

      // 2) 세션 조회 (없으면 새로 생성)
      const { data: sRow, error: sErr } = await supabase
        .from("placement_sessions")
        .select("*")
        .eq("placement_id", placement_id)
        .maybeSingle();
      if (sErr) throw sErr;

      let session: any = sRow ?? null;

      if (!session) {
        const newSession: any = {
          placement_id,
          user_id,
          mode,
          asked_count: 0,
          correct_count: 0,
          current_level: level,
          last_q_id: Q.q_id,
          is_done: false,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
        };
        const { error: insErr } = await supabase.from("placement_sessions").insert(newSession);
        if (insErr) throw insErr;
        session = newSession;
      }

      if (session.is_done) {
        return { content: [{ type: "text", text: "이미 완료된 진단입니다. 다시 시작하려면 placement_start를 호출해 주세요." }], isError: true };
      }

      // 3) 채점
      const graded = gradeAnswer({ choices, correctAnswer: Q.answer, userAnswer: user_answer });

      const asked = Number(session.asked_count ?? 0) + 1;
      const correct = Number(session.correct_count ?? 0) + (graded.isCorrect ? 1 : 0);

      level = Number(session.current_level ?? level);
      if (graded.isCorrect) {
        level = Math.min(10, level + 1);
      } else if (signal === "hard") {
        level = Math.max(1, level - 1);
      }

      const done = asked >= PLACEMENT_QUESTION_COUNT;

      // 4) 로그 저장
      const { error: logErr } = await supabase.from("study_logs").insert({
        user_id,
        q_id: Q.q_id,
        event_type: "placement_attempt",
        ref_id: String(Q.q_id),
        mode,
        level: Q.level,
        is_correct: graded.isCorrect,
        user_answer: graded.userPickValue ?? graded.raw ?? user_answer,
        signal: signal ?? "neutral",
      });
      if (logErr) throw logErr;

      // 5) 세션 업데이트
      const { error: upErr } = await supabase
        .from("placement_sessions")
        .update({
          asked_count: asked,
          correct_count: correct,
          current_level: level,
          last_q_id: Q.q_id,
          finished_at: done ? new Date().toISOString() : null,
          is_done: done,
        })
        .eq("placement_id", placement_id);
      if (upErr) throw upErr;

      // 6) 진단 종료
      if (done) {
        const { error: uUpErr } = await supabase
          .from("users")
          .update({
            current_level: level,
            placement_done: true,
            last_mode: mode,
          })
          .eq("user_id", user_id);
        if (uUpErr) throw uUpErr;

        const text = `✅ 레벨 진단이 끝났어요!

- 맞힌 문제: ${correct}/${asked}
- 최종 레벨: Lv.${level}

이제 "${modeKo(mode)} Lv.${level}" 기준으로 문제를 낼게요.
"다음"이라고 보내면 바로 시작합니다.`;
        return { content: [{ type: "text", text }] };
      }

      // 7) 다음 문제 (중복 회피 랜덤)
      const recent = await getRecentAttemptedQids({ user_id, mode, limit: 120 });
      const nextQ = await pickRandomQuestionAvoiding(mode, level, recent);
      if (!nextQ) {
        return {
          content: [{ type: "text", text: "다음 문제를 찾지 못했습니다. (questions 테이블에 is_active=true 문제를 더 추가해 주세요)" }],
          isError: true,
        };
      }

      const nChoices = (nextQ.choices ?? []) as string[];
      const mediaMd = nextQ.media?.image ? `\n\n![image](${nextQ.media.image})\n` : "";

      const feedback =
        `${graded.isCorrect ? "✅ 정답이에요!" : "❌ 오답이에요."}\n` +
        `- 내 답: ${graded.raw}\n` +
        `- 정답: ${graded.ansStr}\n` +
        `- 해설: ${Q.explanation ?? "(해설 없음)"}\n\n` +
        `현재 임시 레벨: Lv.${level}`;

      const nextText =
        `🧩 ${modeKo(nextQ.mode)} Lv.${nextQ.level}\n` +
        `${nextQ.prompt}${mediaMd}\n\n` +
        `${formatChoicesWithNumbers(nChoices)}\n\n` +
        `q_id: \`${nextQ.q_id}\`\n` +
        `정답은 **숫자(1~)** 또는 **A~E** 로 보내 주세요.`;

      return { content: [{ type: "text", text: `${feedback}\n\n${nextText}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_submit 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------ Tool: get_question ------------------------------ */
server.tool(
  "get_question",
  "모드/레벨에 맞는 활성(is_active=true) 객관식 문제 1개를 랜덤으로 가져옵니다. (최근에 푼 문제는 가능한 피함)",
  { user_id: z.string().min(1).optional(), mode: ModeEnum, level: z.number().int().min(1).max(10) },
  async (args) => {
    const { user_id: rawUid, mode, level } = GetQuestionArgs.parse(args);
    const user_id = resolveUserId(rawUid);
    await ensureUser(user_id, mode);

    const recent = await getRecentAttemptedQids({ user_id, mode, limit: 120 });
    const q = await pickRandomQuestionAvoiding(mode, level, recent);

    if (!q) {
      return { content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다." }] };
    }

    // ✅ pending 저장 (답만 오면 채점 가능)
    pendingByUser.set(user_id, { q_id: String(q.q_id), mode, level: Number(q.level), sent_at: new Date().toISOString() });

    const choices = (q.choices ?? []) as string[];
    const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

    const nudge = shouldShowDifficultyNudge(user_id)
      ? `\n\n난이도는 한 번만 물어볼게요.\n현재 레벨이 **쉬우면 "쉬워요"**, **어려우면 "어려워요"**라고 말해주면 다음부터 조정할게요.`
      : "";

    const text =
      `🧩 ${modeKo(q.mode)} Lv.${q.level}\n` +
      `${q.prompt}${mediaMd}\n\n` +
      `${formatChoicesWithNumbers(choices)}\n\n` +
      `q_id: \`${q.q_id}\`\n` +
      `정답은 **숫자(1~)** 또는 **A~E** 로 보내 주세요.` +
      nudge;

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: submit_answer ------------------------------- */
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장 + (오답이면 자동으로 오답노트(review_items)에 저장)",
  {
    user_id: z.string().optional(),
    q_id: z.string().uuid(),
    user_answer: z.string(),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const parsed = SubmitAnswerArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const { q_id, user_answer, signal } = parsed;

      await ensureUser(user_id, "toeic");

      // 문제 조회
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices, prompt, media")
        .eq("q_id", q_id)
        .maybeSingle();

      if (qErr) throw qErr;
      if (!q) {
        return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }], isError: true };
      }

      const QQ = q as any;
      const choices = (QQ.choices ?? []) as string[];
      const ansRaw = String(QQ.answer ?? "").trim();

      const graded = gradeAnswer({ choices, correctAnswer: QQ.answer, userAnswer: user_answer });

      // ✅ 로그 저장
      const { error: logErr } = await supabase.from("study_logs").insert({
        user_id,
        q_id: QQ.q_id,
        event_type: "quiz_attempt",
        ref_id: String(QQ.q_id),
        mode: QQ.mode,
        level: QQ.level,
        is_correct: graded.isCorrect,
        user_answer: graded.userPickValue ?? graded.raw ?? user_answer,
        signal: signal ?? "neutral",
      });

      if (logErr) throw logErr;

      // ✅ 오답이면 자동 저장 (오답노트가 “저장된게 없다”가 안 뜨게)
      await autoSaveMistake({ user_id, q: QQ, graded, user_answer });

      const dbgPicked =
        graded.userPickIndex != null
          ? `${graded.userPickIndex + 1}번${choices[graded.userPickIndex] ? ` (${choices[graded.userPickIndex]})` : ""}`
          : graded.raw;

      let text =
        `${graded.isCorrect ? "✅ 정답입니다!" : "❌ 오답입니다."}\n\n` +
        `🧩 ${modeKo(QQ.mode)} Lv.${QQ.level}\n` +
        `- 내가 보낸 답: ${String(user_answer).trim()}\n` +
        `- 해석된 선택: ${dbgPicked}\n` +
        `- 정답: ${ansRaw}\n` +
        `- 해설: ${QQ.explanation ?? "(해설 없음)"}\n`;

      // ✅ 레벨 클리어/승급 제안 (같은 레벨 연속 정답 5회)
      const streak = await getConsecutiveCorrectAtLevel({ user_id, mode: QQ.mode, level: Number(QQ.level), limit: 30 });
      if (streak >= 5) {
        awaitingPromotionDecision.set(user_id, { mode: QQ.mode, fromLevel: Number(QQ.level), askedAt: Date.now() });
        text += `\n🏁 ${modeKo(QQ.mode)} Lv.${QQ.level} 연속 정답 ${streak}회!\n다음 레벨로 올릴까요?\n- 올릴게요: "올려"\n- 유지할게요: "유지"\n`;
      } else {
        // ✅ 난이도 안내는 get_question에서만 “1회성”으로 처리 (여기서는 반복 안내 X)
        text += `\n다음 문제는 "다음"이라고 보내 주세요.`;
      }

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(err)}` }], isError: true };
    }
  }
);

/* ------------------------------- Tool: save_item ------------------------------- */
server.tool(
  "save_item",
  "단어/오답/메모를 review_items에 저장합니다. (payload는 없어도 됩니다)",
  {
    user_id: z.string().optional(),
    item_type: z.enum(["vocab", "mistake", "note"]),
    key: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  },
  async (args) => {
    const parsed = SaveItemArgs.parse(args);
    const user_id = resolveUserId(parsed.user_id);
    const { item_type, key, payload } = parsed;

    const defaultMode: Mode = item_type === "vocab" ? "toeic" : "grammar";
    await ensureUser(user_id, defaultMode);

    const { error } = await supabase.from("review_items").insert({
      item_id: randomUUID(),
      user_id,
      item_type,
      key,
      payload: payload ?? {},
      strength: 1,
      last_seen_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    if (error) throw error;

    return { content: [{ type: "text", text: `✅ 저장 완료: [${item_type}] ${key}` }] };
  }
);

/* ------------------------------- Tool: get_review_items ------------------------------- */
server.tool(
  "get_review_items",
  "복습할 아이템(오래 안 본 것 우선)을 가져옵니다.",
  {
    user_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    item_type: z.enum(["vocab", "mistake", "note"]).optional(),
  },
  async (args) => {
    const parsed = GetReviewItemsArgs.parse(args);
    const user_id = resolveUserId(parsed.user_id);
    await ensureUser(user_id, "toeic");

    let query = supabase
      .from("review_items")
      .select("item_id, item_type, key, payload, strength, last_seen_at, created_at")
      .eq("user_id", user_id);

    if (parsed.item_type) query = query.eq("item_type", parsed.item_type);

    const { data, error } = await query.order("last_seen_at", { ascending: true }).limit(parsed.limit);
    if (error) throw error;

    const text =
      `📌 복습 아이템 (${data?.length ?? 0}개)` +
      (data && data.length
        ? "\n\n" +
          data
            .map((it: any, idx: number) => {
              const p = it.payload ?? {};
              const mode = p.mode ? `${modeKo(p.mode)} ` : "";
              const lv = p.level ? `Lv.${p.level}` : "";
              return (
                `${idx + 1}) [${it.item_type}] ${mode}${lv}\n` +
                `- key: ${it.key}\n` +
                `- payload: ${JSON.stringify(it.payload)}`
              );
            })
            .join("\n\n")
        : "\n(없음)");

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: get_learning_summary ------------------------------- */
server.tool(
  "get_learning_summary",
  "기간(최근 N일) 기반 학습 요약을 제공합니다. (간단 통계용)",
  { user_id: z.string().optional(), days: z.number().int().min(1).max(365).optional() },
  async (args) => {
    const parsed = GetLearningSummaryArgs.parse(args);
    const user_id = resolveUserId(parsed.user_id);
    const days = parsed.days;
    await ensureUser(user_id, "toeic");

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data: attempts, error: aErr } = await supabase
      .from("study_logs")
      .select("is_correct, created_at")
      .eq("user_id", user_id)
      .eq("event_type", "quiz_attempt")
      .gte("created_at", since);

    if (aErr) throw aErr;

    const total = attempts?.length ?? 0;
    const wrong = (attempts ?? []).filter((x: any) => x.is_correct === false).length;

    const { data: saved, error: sErr } = await supabase
      .from("review_items")
      .select("item_type, created_at")
      .eq("user_id", user_id)
      .gte("created_at", since);

    if (sErr) throw sErr;

    const savedTotal = saved?.length ?? 0;
    const savedVocab = (saved ?? []).filter((x: any) => x.item_type === "vocab").length;
    const savedMistake = (saved ?? []).filter((x: any) => x.item_type === "mistake").length;

    const text =
      `📊 최근 ${days}일 요약(통계)\n` +
      `- 퀴즈 시도: ${total}회\n` +
      `- 오답: ${wrong}개\n` +
      `- 저장 아이템: ${savedTotal}개 (단어 ${savedVocab}개 / 오답 ${savedMistake}개)`;

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------- Tool: handle_user_message ------------------------ */
server.tool(
  "handle_user_message",
  "사용자 메시지 하나로 학습 흐름을 자동 처리합니다. (모드 선택/다음/정답 채점/난이도 조정/오늘 정리/오답노트/그만=오답노트 자동)",
  { user_id: z.string().min(1).optional(), message: z.string().min(1) },
  async (args) => {
    try {
      const parsed = HandleUserMessageArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const msg = String(parsed.message ?? "").trim();

      await ensureUser(user_id, "toeic");

      // 유저 상태
      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("current_level, last_mode")
        .eq("user_id", user_id)
        .maybeSingle();
      if (uErr) throw uErr;

      let currentLevel = Number((u as any)?.current_level ?? 3);
      let currentMode = ((u as any)?.last_mode ?? "toeic") as Mode;

      // 0) 승급 응답 처리
      const promo = awaitingPromotionDecision.get(user_id);
      if (promo) {
        if (isPromotionYes(msg)) {
          const newLevel = Math.min(10, promo.fromLevel + 1);
          await supabase.from("users").update({ current_level: newLevel, last_mode: promo.mode }).eq("user_id", user_id);
          awaitingPromotionDecision.delete(user_id);

          const recent = await getRecentAttemptedQids({ user_id, mode: promo.mode, limit: 150 });
          const q = await pickRandomQuestionAvoiding(promo.mode, newLevel, recent);
          if (!q) {
            return { content: [{ type: "text", text: `✅ 레벨을 Lv.${newLevel}로 올렸어요.\n그런데 Lv.${newLevel} 문제를 찾지 못했습니다. questions 테이블에 문제를 추가해 주세요.` }] };
          }

          pendingByUser.set(user_id, { q_id: String(q.q_id), mode: promo.mode, level: Number(q.level), sent_at: new Date().toISOString() });

          const choices = (q.choices ?? []) as string[];
          const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

          const text =
            `✅ 레벨 업! ${modeKo(promo.mode)} Lv.${newLevel}\n\n` +
            `🧩 ${modeKo(q.mode)} Lv.${q.level}\n` +
            `${q.prompt}${mediaMd}\n\n` +
            `${formatChoicesWithNumbers(choices)}\n\n` +
            `정답은 **숫자(1~)** 또는 **A~E** 로 보내 주세요.`;

          return { content: [{ type: "text", text }] };
        }

        if (isPromotionNo(msg)) {
          awaitingPromotionDecision.delete(user_id);
          return { content: [{ type: "text", text: `OK. ${modeKo(promo.mode)} Lv.${promo.fromLevel} 유지할게요.\n"다음"이라고 보내면 계속 진행합니다.` }] };
        }
        // 딴 말이면 계속 대기 상태 유지 (흐름 깨지 않게 그냥 다음 처리)
      }

      // 1) 그만/종료 => 오늘 오답노트 자동
      if (isStop(msg)) {
        const note = await buildTodayMistakeNoteWithReview(user_id);
        return { content: [{ type: "text", text: `${note}\n\n(학습 종료)` }] };
      }

      // 2) 오늘 정리/요약
      if (isSummary(msg)) {
        const summary = await buildTodayFullSummary(user_id);
        return { content: [{ type: "text", text: summary }] };
      }

      // 3) 오답노트
      if (isMistakeNote(msg)) {
        const note = await buildTodayMistakeNoteWithReview(user_id);
        return { content: [{ type: "text", text: note }] };
      }

      // 4) 모드 변경
      const maybeMode = parseModeFromMessage(msg);
      if (maybeMode) {
        currentMode = maybeMode;
        const { error: upErr } = await supabase.from("users").update({ last_mode: currentMode }).eq("user_id", user_id);
        if (upErr) throw upErr;

        return {
          content: [
            {
              type: "text",
              text:
                `OK. ${modeKo(currentMode)}로 할게요.\n` +
                `현재 레벨: Lv.${currentLevel}\n\n` +
                `문제 풀려면 "다음"이라고 보내 주세요.`,
            },
          ],
        };
      }

      // 5) 난이도 신호 (처음 1회 안내만, 신호는 언제든 반영)
      if (isEasySignal(msg)) {
        currentLevel = Math.min(10, currentLevel + 1);
        const { error: upErr } = await supabase.from("users").update({ current_level: currentLevel }).eq("user_id", user_id);
        if (upErr) throw upErr;
        return { content: [{ type: "text", text: `난이도를 올렸어요. 현재 ${modeKo(currentMode)} Lv.${currentLevel}\n"다음"이라고 보내면 이어서 낼게요.` }] };
      }

      if (isHardSignal(msg)) {
        currentLevel = Math.max(1, currentLevel - 1);
        const { error: upErr } = await supabase.from("users").update({ current_level: currentLevel }).eq("user_id", user_id);
        if (upErr) throw upErr;
        return { content: [{ type: "text", text: `난이도를 내렸어요. 현재 ${modeKo(currentMode)} Lv.${currentLevel}\n"다음"이라고 보내면 이어서 낼게요.` }] };
      }

      // 6) 답만 온 경우 => pending 있으면 채점, 없으면 안내
      if (isAnswerToken(msg)) {
        const pending = pendingByUser.get(user_id);
        if (!pending) {
          return { content: [{ type: "text", text: `지금 채점할 문제가 없어요. 먼저 "다음"이라고 보내서 문제를 받아주세요.` }] };
        }

        // submit_answer 내부 로직 수행(도구 호출 없이 직접)
        const { data: q, error: qErr } = await supabase
          .from("questions")
          .select("q_id, mode, level, answer, explanation, choices, prompt, media")
          .eq("q_id", pending.q_id)
          .maybeSingle();

        if (qErr) throw qErr;
        if (!q) {
          pendingByUser.delete(user_id);
          return { content: [{ type: "text", text: `문제를 찾지 못했어요. "다음"이라고 보내면 새 문제를 낼게요.` }] };
        }

        const QQ = q as any;
        const choices = (QQ.choices ?? []) as string[];
        const graded = gradeAnswer({ choices, correctAnswer: QQ.answer, userAnswer: msg });

        const { error: logErr } = await supabase.from("study_logs").insert({
          user_id,
          q_id: QQ.q_id,
          event_type: "quiz_attempt",
          ref_id: String(QQ.q_id),
          mode: QQ.mode,
          level: QQ.level,
          is_correct: graded.isCorrect,
          user_answer: graded.userPickValue ?? graded.raw ?? msg,
          signal: "neutral",
        });
        if (logErr) throw logErr;

        await autoSaveMistake({ user_id, q: QQ, graded, user_answer: msg });

        // pending clear
        pendingByUser.delete(user_id);

        const dbgPicked =
          graded.userPickIndex != null
            ? `${graded.userPickIndex + 1}번${choices[graded.userPickIndex] ? ` (${choices[graded.userPickIndex]})` : ""}`
            : graded.raw;

        let text =
          `${graded.isCorrect ? "✅ 정답입니다!" : "❌ 오답입니다."}\n\n` +
          `🧩 ${modeKo(QQ.mode)} Lv.${QQ.level}\n` +
          `- 내 답: ${msg}\n` +
          `- 해석된 선택: ${dbgPicked}\n` +
          `- 정답: ${String(QQ.answer ?? "").trim()}\n` +
          `- 해설: ${QQ.explanation ?? "(해설 없음)"}\n`;

        // 승급 제안 체크
        const streak = await getConsecutiveCorrectAtLevel({ user_id, mode: QQ.mode, level: Number(QQ.level), limit: 30 });
        if (streak >= 5) {
          awaitingPromotionDecision.set(user_id, { mode: QQ.mode, fromLevel: Number(QQ.level), askedAt: Date.now() });
          text += `\n🏁 ${modeKo(QQ.mode)} Lv.${QQ.level} 연속 정답 ${streak}회!\n다음 레벨로 올릴까요?\n- 올릴게요: "올려"\n- 유지: "유지"\n`;
        } else {
          text += `\n다음 문제는 "다음"이라고 보내 주세요.`;
        }

        return { content: [{ type: "text", text }] };
      }

      // 7) 다음/계속 => 문제 제공
      if (isNext(msg) || msg === "시작" || msg === "영어공부할래") {
        // 영어공부할래면 모드부터 한번 물어보기
        if (msg === "영어공부할래") {
          return { content: [{ type: "text", text: `어떤 걸로 할까요?\n- 토익 / 문법 / 여행 / 비즈니스 / 단어\n원하는 모드를 말해줘.` }] };
        }

        // 현재 모드/레벨로 문제
        const recent = await getRecentAttemptedQids({ user_id, mode: currentMode, limit: 150 });
        const q = await pickRandomQuestionAvoiding(currentMode, currentLevel, recent);
        if (!q) {
          return { content: [{ type: "text", text: `${modeKo(currentMode)} Lv.${currentLevel} 문제를 찾지 못했어요. questions 테이블에 문제를 추가해 주세요.` }], isError: true };
        }

        pendingByUser.set(user_id, { q_id: String(q.q_id), mode: currentMode, level: Number(q.level), sent_at: new Date().toISOString() });

        const choices = (q.choices ?? []) as string[];
        const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

        const nudge = shouldShowDifficultyNudge(user_id)
          ? `\n\n난이도는 한 번만 물어볼게요.\n현재 레벨이 **쉬우면 "쉬워요"**, **어려우면 "어려워요"**라고 말해주면 다음부터 조정할게요.`
          : "";

        const text =
          `🧩 ${modeKo(q.mode)} Lv.${q.level}\n` +
          `${q.prompt}${mediaMd}\n\n` +
          `${formatChoicesWithNumbers(choices)}\n\n` +
          `정답은 **숫자(1~)** 또는 **A~E** 로 보내 주세요.` +
          nudge;

        return { content: [{ type: "text", text }] };
      }

      // 8) 그 외: 짧은 도움말
      return {
        content: [
          {
            type: "text",
            text:
              `할 수 있는 것:\n` +
              `- "토익/문법/여행/비즈니스/단어" (모드 변경)\n` +
              `- "다음" (문제 받기)\n` +
              `- 정답만 보내기: 1 또는 A\n` +
              `- "쉬워요" / "어려워요" (레벨 조정)\n` +
              `- "정리" 또는 "요약" (오늘 푼 문제 전체: 문제+답+해설)\n` +
              `- "오답노트" (오늘 오답: 문제+답+해설 + 복습문제 1개)\n` +
              `- "그만" (자동으로 오늘 오답노트 출력 후 종료)`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `handle_user_message 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------- Express App ------------------------------ */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/* -------------------------- Session / Transport Store --------------------- */
const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionsLastSeen: Record<string, number> = {};
const SESSION_TTL_MS = 1000 * 60 * 30;

setInterval(() => {
  const now = Date.now();
  for (const [sid, last] of Object.entries(sessionsLastSeen)) {
    if (now - last > SESSION_TTL_MS) {
      delete sessionsLastSeen[sid];
      delete transports[sid];
    }
  }
}, 1000 * 60 * 5);

/* ---------------------------------- MCP ---------------------------------- */
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    if (!mustAcceptSseAndJson(req)) {
      res.status(406).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Not Acceptable: Client must accept both application/json and text/event-stream",
        },
        id: null,
      });
      return;
    }

    const incomingSessionId = (req.headers["mcp-session-id"] as string) || "";
    let transport = incomingSessionId ? transports[incomingSessionId] : undefined;

    if (!transport) {
      const newSessionId = randomUUID();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
      });

      transports[newSessionId] = transport;
      sessionsLastSeen[newSessionId] = Date.now();

      await server.connect(transport);

      res.setHeader("mcp-session-id", newSessionId);
    } else {
      sessionsLastSeen[incomingSessionId] = Date.now();
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[/mcp POST] error:", err);
    safeJsonRpcError(res);
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  try {
    if (!mustAcceptSseAndJson(req)) {
      res.status(406).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Not Acceptable: Client must accept both application/json and text/event-stream",
        },
        id: null,
      });
      return;
    }

    const sessionId = (req.headers["mcp-session-id"] as string) || "";
    if (!sessionId) {
      res.status(400).json({ error: "Missing mcp-session-id" });
      return;
    }

    sessionsLastSeen[sessionId] = Date.now();

    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    await transport.handleRequest(req, res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[/mcp GET] error:", err);
    safeJsonRpcError(res);
  }
});

/* --------------------------------- Listen -------------------------------- */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`✅ MCP HTTP Server running: http://0.0.0.0:${PORT}/mcp`);
});