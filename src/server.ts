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
  mode: ModeEnum,
  level: z.number().int().min(1).max(10),
});

const SubmitAnswerArgs = z.object({
  user_id: z.string().min(1).optional(),
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

const SaveItemArgs = z.object({
  user_id: z.string().min(1).optional(),
  item_type: z.enum(["vocab", "mistake", "note"]),
  key: z.string().min(1),
  // ✅ 카카오에서 payload를 안 보내도 저장되게(기본값 {})
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

const GetReviewItemsArgs = z.object({
  user_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(5),
  item_type: z.enum(["vocab", "mistake", "note"]).optional(),
});

const GetLearningSummaryArgs = z.object({
  user_id: z.string().min(1).optional(),
  days: z.number().int().min(1).max(365).default(7),
});

// 진단 관련
const GetUserStateArgs = z.object({
  user_id: z.string().min(1).optional(),
});

const PlacementStartArgs = z.object({
  user_id: z.string().min(1).optional(),
  mode: ModeEnum,
});

const PlacementSubmitArgs = z.object({
  user_id: z.string().min(1).optional(),
  placement_id: z.string().uuid(),
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

/* ------------------------------- Chat Router ------------------------------ */
const HandleUserMessageArgs = z.object({
  user_id: z.string().min(1).optional(),
  message: z.string().min(1),
});

/* -------------------------------- Helpers -------------------------------- */

// ✅ user_id가 없으면 공통 ID로 대체 (카카오 데모용)
function resolveUserId(raw: unknown): string {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "kakao_default";
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

function modeKo(mode: Mode) {
  switch (mode) {
    case "toeic":
      return "토익";
    case "grammar":
      return "문법";
    case "travel":
      return "여행영어";
    case "business":
      return "비즈니스";
    case "vocab":
      return "단어";
    default:
      return mode;
  }
}

// ✅ “A. foo” 형태로 이미 들어온 choice도 정리
function stripChoicePrefix(choice: string) {
  const s = String(choice ?? "").trim();
  // "A. xxx" / "A) xxx" 제거
  const m = s.match(/^[A-Ea-e]\s*[\.\)]\s*(.+)$/);
  return m ? m[1].trim() : s;
}

function formatChoicesWithNumberAndAlpha(choices: string[]) {
  const alpha = ["A", "B", "C", "D", "E"];
  return choices.map((c, i) => `${i + 1}. ${alpha[i] ? `${alpha[i]}. ` : ""}${stripChoicePrefix(c)}`);
}

/* ------------------------- KST “today” time range ------------------------- */
const KST_OFFSET_MIN = 9 * 60;
function startOfTodayKSTIso() {
  const now = new Date();
  // UTC ms → KST ms
  const kstMs = now.getTime() + KST_OFFSET_MIN * 60_000;
  const kst = new Date(kstMs);
  // KST 기준 00:00
  const startKst = new Date(kst.getFullYear(), kst.getMonth(), kst.getDate(), 0, 0, 0, 0);
  // 다시 UTC로 환산
  const startUtcMs = startKst.getTime() - KST_OFFSET_MIN * 60_000;
  return new Date(startUtcMs).toISOString();
}

/* -------------------------- Minimal in-memory state ------------------------ */
/**
 * 카카오/챗봇은 “대화형”이라 서버가 “마지막 문제 q_id” 같은 걸 기억해야 함.
 * Supabase에 세션 테이블을 새로 만들지 않고, 우선 서버 메모리에 유지(간단/즉시).
 * (단, 서버 재시작 시 초기화됨)
 */
type UserChatState = {
  mode: Mode;
  level: number;
  lastQid?: string;
  recentQids: string[]; // 중복 방지
  askedDifficultyOnce: boolean; // 난이도 피드백 질문 1회만
  correctStreakAtLevel: number; // 레벨 승급 제안용
  pendingLevelUpOffer?: { fromLevel: number; toLevel: number }; // “올릴까?” 질문 상태
  autoNextRemaining: number; // “5문제 ㄱㄱ” → 자동 연속 출제
};

const chatState: Record<string, UserChatState> = {};
const CHAT_RECENT_MAX = 20;

function getOrInitChatState(user_id: string): UserChatState {
  if (!chatState[user_id]) {
    chatState[user_id] = {
      mode: "toeic",
      level: 3,
      recentQids: [],
      askedDifficultyOnce: false,
      correctStreakAtLevel: 0,
      autoNextRemaining: 0,
    };
  }
  return chatState[user_id];
}

function pushRecent(state: UserChatState, q_id: string) {
  state.recentQids.unshift(q_id);
  state.recentQids = state.recentQids.slice(0, CHAT_RECENT_MAX);
}

/* ------------------------------- DB helpers ------------------------------- */
async function ensureUser(user_id: string, mode?: Mode) {
  const { data, error } = await supabase
    .from("users")
    .select("user_id, current_level, placement_done, last_mode")
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

/** 사용자 기본 레벨/마지막 모드 가져오기(있으면 chatState도 동기화) */
async function hydrateUserState(user_id: string) {
  await ensureUser(user_id, "toeic");
  const { data, error } = await supabase
    .from("users")
    .select("current_level, last_mode")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;

  const st = getOrInitChatState(user_id);
  const lvl = Number((data as any)?.current_level ?? st.level ?? 3);
  const md = ((data as any)?.last_mode ?? st.mode ?? "toeic") as Mode;
  st.level = Math.min(10, Math.max(1, lvl));
  st.mode = ModeEnum.safeParse(md).success ? md : "toeic";
  return st;
}

/* -------------------------- Question picking logic ------------------------ */

// 랜덤 문제 뽑기 (같은 mode/level에서 랜덤)
async function pickRandomQuestion(mode: Mode, level: number) {
  const { data, error } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true)
    .limit(50);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx] as any;
}

// ✅ 최근 문제 제외 + 없으면 level ±1로 완화
async function pickQuestionAvoidingRecent(opts: {
  mode: Mode;
  level: number;
  excludeQids: string[];
}) {
  const { mode, level, excludeQids } = opts;

  const tryLevels = [
    level,
    Math.min(10, level + 1),
    Math.max(1, level - 1),
    Math.min(10, level + 2),
    Math.max(1, level - 2),
  ];

  for (const lv of tryLevels) {
    const q = await pickRandomQuestion(mode, lv);
    if (!q) continue;
    if (!excludeQids.includes(String(q.q_id))) return q;
  }

  // 마지막 fallback: mode 전체에서 아무거나
  const { data, error } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("is_active", true)
    .limit(50);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const filtered = data.filter((x: any) => !excludeQids.includes(String(x.q_id)));
  const pool = filtered.length ? filtered : data;
  return pool[Math.floor(Math.random() * pool.length)] as any;
}

/* ------------------------------ Grading helper ---------------------------- */

// 선택지 채점 헬퍼 (1/A/B/C/D 다 처리)
function gradeAnswer(opts: {
  choices: string[];
  correctAnswer: unknown;
  userAnswer: string;
}) {
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
    return {
      isCorrect: ansIndex === userPickIndex,
      raw,
      userPickIndex,
      userPickValue,
      ansStr,
    };
  }

  // 정답이 "A","B"처럼 알파벳인 경우
  if (ansStr.length === 1 && ansUpper in alphaMap && userPickIndex !== null) {
    return {
      isCorrect: alphaMap[ansUpper] === userPickIndex,
      raw,
      userPickIndex,
      userPickValue,
      ansStr,
    };
  }

  // 그 외에는 텍스트 비교
  const isCorrect =
    userPickValue.trim().toUpperCase() === ansUpper ||
    raw.trim().toUpperCase() === ansUpper;

  return { isCorrect, raw, userPickIndex, userPickValue, ansStr };
}

/* ------------------------ Formatting (mode+level top) ---------------------- */
function formatQuestionText(q: any) {
  const mode = (q.mode ?? "toeic") as Mode;
  const level = Number(q.level ?? 3);
  const choices = (q.choices ?? []) as string[];
  const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

  const header = `${modeKo(mode)} ${level}레벨`;
  const choiceLines = choices.length
    ? formatChoicesWithNumberAndAlpha(choices).join("\n")
    : "(선택지가 없습니다)";

  return `🧩 ${header}
${q.prompt}${mediaMd}

${choiceLines}

q_id: \`${q.q_id}\`

정답은 **숫자 하나(1~4)** 또는 **알파벳 하나(A~D)** 로 보내 주세요.`;
}

/* ----------------------------- Mistake saving ----------------------------- */
function extractVocabWord(prompt: string) {
  // 예) "단어 confirm에 가장 가까운 뜻은 무엇일까요?"
  const s = String(prompt ?? "").trim();
  const m = s.match(/단어\s+([A-Za-z\-']+)\s*에/i);
  return m ? m[1] : null;
}

async function saveMistakeAuto(opts: {
  user_id: string;
  q: any;
  graded: ReturnType<typeof gradeAnswer>;
  rawUserAnswer: string;
}) {
  const { user_id, q, graded, rawUserAnswer } = opts;

  const mode = (q.mode ?? "toeic") as Mode;
  const level = Number(q.level ?? 3);
  const choices = (q.choices ?? []) as string[];
  const ansRaw = String(q.answer ?? "").trim();
  const vocabWord = mode === "vocab" ? extractVocabWord(String(q.prompt ?? "")) : null;

  const key = vocabWord ? vocabWord : String(q.q_id);

  const payload = {
    mode,
    level,
    q_id: String(q.q_id),
    prompt: String(q.prompt ?? ""),
    choices,
    correct: ansRaw,
    explanation: String(q.explanation ?? ""),
    user_answer_raw: String(rawUserAnswer ?? ""),
    user_answer_parsed: String(graded.userPickValue ?? graded.raw ?? rawUserAnswer),
    created_kst_date: new Date().toISOString(), // 표시용(정밀 KST 변환은 UI/리포트에서)
  };

  const { error } = await supabase.from("review_items").insert({
    item_id: randomUUID(),
    user_id,
    item_type: "mistake",
    key,
    payload,
    strength: 1,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });

  // 저장 실패해도 학습 플로우는 끊지 않음(로그만)
  if (error) console.error("[saveMistakeAuto] error:", error);
}

/* ----------------------------- Daily reports ------------------------------ */
async function buildTodayAttemptsReport(opts: {
  user_id: string;
  type: "all" | "mistake";
  limit?: number;
}) {
  const { user_id, type } = opts;
  const since = startOfTodayKSTIso();

  const { data: logs, error: lErr } = await supabase
    .from("study_logs")
    .select("q_id, mode, level, is_correct, user_answer, created_at")
    .eq("user_id", user_id)
    .in("event_type", ["quiz_attempt", "placement_attempt"])
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (lErr) throw lErr;

  const rows = (logs ?? []) as any[];
  const filtered = type === "mistake" ? rows.filter((r) => r.is_correct === false) : rows;

  if (!filtered.length) {
    if (type === "mistake") return "오늘 오답이 없습니다. 👍";
    return "오늘 푼 문제가 없습니다.";
  }

  // questions 배치 로드
  const qids = Array.from(new Set(filtered.map((r) => String(r.q_id))));
  const { data: qs, error: qErr } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .in("q_id", qids);

  if (qErr) throw qErr;

  const qMap = new Map<string, any>();
  (qs ?? []).forEach((q: any) => qMap.set(String(q.q_id), q));

  const blocks = filtered.map((r, idx) => {
    const q = qMap.get(String(r.q_id));
    const mode = ((q?.mode ?? r.mode ?? "toeic") as Mode);
    const level = Number(q?.level ?? r.level ?? 3);
    const header = `${idx + 1}) ${modeKo(mode)} ${level}레벨`;
    if (!q) {
      return `${header}\n(문제 데이터 로드 실패: q_id=${String(r.q_id)})`;
    }
    const choices = (q.choices ?? []) as string[];
    const choiceLines = choices.length ? formatChoicesWithNumberAndAlpha(choices).join("\n") : "(선택지 없음)";
    const ansRaw = String(q.answer ?? "").trim();
    const ua = String(r.user_answer ?? "").trim();
    const mark = r.is_correct ? "✅ 정답" : "❌ 오답";

    return `${header} — ${mark}
${q.prompt}

${choiceLines}

- 내 답: ${ua}
- 정답: ${ansRaw}
- 해설: ${q.explanation ?? "(해설 없음)"}
(q_id: ${q.q_id})`;
  });

  if (type === "mistake") return `📌 오늘 오답노트\n\n${blocks.join("\n\n---\n\n")}`;
  return `📚 오늘 학습 정리\n\n${blocks.join("\n\n---\n\n")}`;
}

async function buildMistakeReviewWithSimilarQuestions(opts: {
  user_id: string;
  baseMode?: Mode;
  baseLevel?: number;
}) {
  const note = await buildTodayAttemptsReport({ user_id: opts.user_id, type: "mistake" });
  if (note.startsWith("오늘 오답이 없습니다")) return note;

  // 유사문제 2개: (모드/레벨 기반으로 랜덤) - 최근 출제와 겹치지 않게
  const st = getOrInitChatState(opts.user_id);
  const mode = opts.baseMode ?? st.mode;
  const level = opts.baseLevel ?? st.level;

  const q1 = await pickQuestionAvoidingRecent({ mode, level, excludeQids: st.recentQids });
  if (q1) pushRecent(st, String(q1.q_id));
  const q2 = await pickQuestionAvoidingRecent({ mode, level, excludeQids: st.recentQids });
  if (q2) pushRecent(st, String(q2.q_id));

  const reviewParts: string[] = [];
  if (q1) reviewParts.push(`🔁 복습 1\n${formatQuestionText(q1)}`);
  if (q2) reviewParts.push(`🔁 복습 2\n${formatQuestionText(q2)}`);

  return `${note}\n\n\n✅ 오답 확인 복습(유사문제)\n\n${reviewParts.length ? reviewParts.join("\n\n") : "(복습 문제를 찾지 못했습니다.)"}`;
}

/* ----------------------------- Placement Config --------------------------- */
const PLACEMENT_QUESTION_COUNT = 5;

/* ------------------------------- MCP Server ------------------------------- */
const server = new McpServer({ name: "playlearn-mcp", version: "1.1.0" });

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

      // 2) 세션 조회 (없으면 생성)
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
        return {
          content: [{ type: "text", text: "이미 완료된 진단입니다. 다시 시작하려면 '테스트 다시'라고 말씀해 주세요." }],
          isError: true,
        };
      }

      // 3) 채점
      const graded = gradeAnswer({
        choices,
        correctAnswer: Q.answer,
        userAnswer: user_answer,
      });

      const asked = Number(session.asked_count ?? 0) + 1;
      const correct = Number(session.correct_count ?? 0) + (graded.isCorrect ? 1 : 0);

      level = Number(session.current_level ?? level);
      if (graded.isCorrect) level = Math.min(10, level + 1);
      else if (signal === "hard") level = Math.max(1, level - 1);

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

      // 5) 오답은 자동 저장(진단도 포함)
      if (!graded.isCorrect) {
        await saveMistakeAuto({ user_id, q: Q, graded, rawUserAnswer: user_answer });
      }

      // 6) 세션 업데이트
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

      // 7) 종료
      if (done) {
        const { error: uUpErr } = await supabase
          .from("users")
          .update({ current_level: level, placement_done: true, last_mode: mode })
          .eq("user_id", user_id);
        if (uUpErr) throw uUpErr;

        const text = `✅ 레벨 진단이 끝났어요!

- 맞힌 문제: ${correct}/${asked}
- 최종 레벨: Lv.${level}

이제 이 레벨 기준으로 문제를 낼게요.
"다음"이라고 보내면 바로 시작합니다.`;
        return { content: [{ type: "text", text }] };
      }

      // 8) 다음 문제
      const nextQ = await pickQuestionAvoidingRecent({ mode, level, excludeQids: [String(Q.q_id)] });
      if (!nextQ) {
        return {
          content: [{ type: "text", text: "다음 문제를 찾지 못했습니다. (questions 테이블에 is_active=true 문제를 더 추가해 주세요)" }],
          isError: true,
        };
      }

      const feedback = `${graded.isCorrect ? "✅ 정답이에요!" : "❌ 오답이에요."}
- 내 답: ${graded.raw}
- 정답: ${String(Q.answer ?? "").trim()}
- 해설: ${Q.explanation ?? "(해설 없음)"}

현재 임시 레벨: Lv.${level}`;

      return { content: [{ type: "text", text: `${feedback}\n\n${formatQuestionText(nextQ)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_submit 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------ Tool: get_question ------------------------------ */
server.tool(
  "get_question",
  "모드/레벨에 맞는 활성(is_active=true) 객관식 문제 1개를 가져옵니다. (최근 문제 중복 방지 포함)",
  { mode: ModeEnum, level: z.number().int().min(1).max(10) },
  async (args) => {
    const { mode, level } = GetQuestionArgs.parse(args);
    const q = await pickQuestionAvoidingRecent({ mode, level, excludeQids: [] });
    if (!q) {
      return { content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다." }] };
    }
    return { content: [{ type: "text", text: formatQuestionText(q) }] };
  }
);

/* ------------------------------- Tool: submit_answer ------------------------------- */
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장 + 오답 자동 저장",
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
        .select("q_id, mode, level, answer, explanation, choices, prompt")
        .eq("q_id", q_id)
        .maybeSingle();

      if (qErr) throw qErr;
      if (!q) {
        return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }], isError: true };
      }

      const QQ = q as any;
      const choices = (QQ.choices ?? []) as string[];
      const ansRaw = String(QQ.answer ?? "").trim();

      const graded = gradeAnswer({
        choices,
        correctAnswer: QQ.answer,
        userAnswer: user_answer,
      });

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

      // ✅ 오답은 자동 저장(사용자 “저장해줘” 없이도)
      if (!graded.isCorrect) {
        await saveMistakeAuto({ user_id, q: QQ, graded, rawUserAnswer: user_answer });
      }

      const dbgPicked =
        graded.userPickIndex != null
          ? `${graded.userPickIndex + 1}번 (${["A", "B", "C", "D", "E"][graded.userPickIndex] ?? ""}. ${stripChoicePrefix(
              choices[graded.userPickIndex] ?? ""
            )})`
          : graded.raw;

      // ✅ 난이도 유도 문구는 “항상” 넣지 않음(원하는 UX)
      const text = `${graded.isCorrect ? "✅ 정답입니다!" : "❌ 오답입니다."}

- 내 답: ${String(user_answer).trim()}
- 해석된 선택: ${dbgPicked}
- 정답: ${ansRaw}
- 해설: ${QQ.explanation ?? "(해설 없음)"}`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(err)}` }], isError: true };
    }
  }
);

/* ------------------------------- Tool: save_item ------------------------------- */
server.tool(
  "save_item",
  "단어/오답/메모를 review_items에 저장합니다. (payload 없으면 자동 {} 저장)",
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
              const title = `${idx + 1}) [${it.item_type}] ${it.key}`;
              if (it.item_type === "mistake" && p.prompt) {
                const choices = Array.isArray(p.choices) ? (p.choices as string[]) : [];
                const choiceLines = choices.length ? formatChoicesWithNumberAndAlpha(choices).join("\n") : "(선택지 없음)";
                return `${title}
- 모드/레벨: ${modeKo((p.mode ?? "toeic") as Mode)} ${Number(p.level ?? 3)}레벨
- 문제: ${p.prompt}
${choiceLines}
- 정답: ${String(p.correct ?? "")}
- 해설: ${String(p.explanation ?? "")}`;
              }
              return `${title}\n- payload: ${JSON.stringify(p)}`;
            })
            .join("\n\n")
        : "\n(없음)");

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: get_learning_summary ------------------------------- */
server.tool(
  "get_learning_summary",
  "기간(최근 N일) 기반 학습 요약(카운트용)을 제공합니다. (참고용 유지)",
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

    const text = `📊 최근 ${days}일 요약
- 퀴즈 시도: ${total}회
- 오답: ${wrong}개
- 저장 아이템: ${savedTotal}개 (단어 ${savedVocab}개)`;

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: handle_user_message ------------------------------- */
/**
 * ✅ “진짜 채팅형 학습 UX”용 라우터
 * - 모드 선택/변경: 토익/문법/여행/비즈니스/단어
 * - 다음 문제: 다음/계속/문제
 * - 답안 제출: 1~5 / A~E
 * - 난이도 피드백: 쉬워요/어려워요/적당
 *   -> “처음 한 번만” 안내(askedDifficultyOnce)
 * - 레벨 클리어: 해당 레벨 연속 정답 5회 달성 시 승급 제안(예/아니오)
 * - 요약/정리: 오늘 푼 문제 전체(문제+내답+정답+해설)
 * - 오답노트/오답: 오늘 틀린 문제 전체 + 유사문제 복습 2개
 * - 그만/종료/끝: 자동으로 오늘 오답노트 출력
 * - “5문제 ㄱㄱ”: 자동 연속 출제 5회(답을 입력하면 다음을 자동으로 붙여서 줌)
 */
server.tool(
  "handle_user_message",
  "자연어 메시지를 해석하여 학습을 진행합니다. (카카오 채팅형 운영용)",
  { user_id: z.string().optional(), message: z.string() },
  async (args) => {
    try {
      const parsed = HandleUserMessageArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const msgRaw = parsed.message;
      const msg = msgRaw.trim();

      const st = await hydrateUserState(user_id);

      // 기본 텍스트 판별
      const lower = msg.toLowerCase();

      const isStop =
        /^(그만|끝|종료|스톱|stop|quit|오늘은 여기까지)/i.test(msg);

      const isSummary =
        /(요약|정리|오늘 공부|오늘 푼 문제|전체 정리)/i.test(msg);

      const isMistakeNote =
        /(오답노트|오답\s*정리|오늘 오답|틀린 문제|복습해|오답)/i.test(msg);

      const wantsFive =
        /(5문제|다섯문제|연속\s*5|5개)/i.test(msg);

      const wantsNext =
        /^(다음|계속|문제|start|시작|go)$/i.test(msg) ||
        /(다음 문제|문제 줘)/i.test(msg);

      const isDifficultyEasy = /(쉬워요|쉬움|easy)/i.test(msg);
      const isDifficultyHard = /(어려워요|어려움|hard)/i.test(msg);
      const isDifficultyNeutral = /(적당|보통|neutral)/i.test(msg);

      const isYes = /^(예|응|ㅇㅇ|올려|올릴래|가자|yes|y)$/i.test(msg);
      const isNo = /^(아니|ㄴㄴ|안해|그대로|no|n)$/i.test(msg);

      const isAnswerToken = /^[A-Ea-e]$/.test(msg) || /^\d+$/.test(msg);

      // 모드 변경
      const modeSwitch = (() => {
        if (/(토익|toeic)/i.test(msg)) return "toeic" as Mode;
        if (/(문법|grammar)/i.test(msg)) return "grammar" as Mode;
        if (/(여행|travel)/i.test(msg)) return "travel" as Mode;
        if (/(비즈니스|business)/i.test(msg)) return "business" as Mode;
        if (/(단어|어휘|vocab)/i.test(msg)) return "vocab" as Mode;
        return null;
      })();

      // 1) 종료 → 자동 오답노트
      if (isStop) {
        const note = await buildMistakeReviewWithSimilarQuestions({
          user_id,
          baseMode: st.mode,
          baseLevel: st.level,
        });
        return { content: [{ type: "text", text: `${note}\n\n(오늘은 여기까지 👍)` }] };
      }

      // 2) 요약/정리
      if (isSummary) {
        const rep = await buildTodayAttemptsReport({ user_id, type: "all" });
        return { content: [{ type: "text", text: rep }] };
      }

      // 3) 오답노트/오답
      if (isMistakeNote) {
        const rep = await buildMistakeReviewWithSimilarQuestions({
          user_id,
          baseMode: st.mode,
          baseLevel: st.level,
        });
        return { content: [{ type: "text", text: rep }] };
      }

      // 4) 모드 전환 처리
      if (modeSwitch) {
        st.mode = modeSwitch;
        // 유저 테이블에도 last_mode 저장
        await supabase.from("users").update({ last_mode: st.mode }).eq("user_id", user_id);

        // 모드 바꾸면 “난이도 질문 1회”를 다시 열어주는 편이 자연스러움
        st.askedDifficultyOnce = false;
        st.correctStreakAtLevel = 0;
        st.pendingLevelUpOffer = undefined;

        return {
          content: [
            {
              type: "text",
              text: `모드를 ${modeKo(st.mode)}로 바꿨어요.\n"다음"이라고 하면 ${modeKo(st.mode)} ${st.level}레벨 문제를 낼게요.`,
            },
          ],
        };
      }

      // 5) 레벨 업 제안에 대한 응답(예/아니오)
      if (st.pendingLevelUpOffer) {
        if (isYes) {
          st.level = Math.min(10, st.pendingLevelUpOffer.toLevel);
          st.correctStreakAtLevel = 0;
          st.pendingLevelUpOffer = undefined;

          await supabase.from("users").update({ current_level: st.level }).eq("user_id", user_id);

          const q = await pickQuestionAvoidingRecent({ mode: st.mode, level: st.level, excludeQids: st.recentQids });
          if (!q) return { content: [{ type: "text", text: "문제를 찾지 못했습니다. questions 데이터를 확인해 주세요." }], isError: true };
          st.lastQid = String(q.q_id);
          pushRecent(st, String(q.q_id));

          return { content: [{ type: "text", text: `✅ 좋아요! ${modeKo(st.mode)} ${st.level}레벨로 올렸어요.\n\n${formatQuestionText(q)}` }] };
        }

        if (isNo) {
          st.correctStreakAtLevel = 0;
          st.pendingLevelUpOffer = undefined;
          return { content: [{ type: "text", text: `오케이. ${modeKo(st.mode)} ${st.level}레벨 그대로 계속 갈게요.\n"다음"이라고 하면 계속 출제합니다.` }] };
        }

        return { content: [{ type: "text", text: `레벨을 올릴까요?\n- 예 / 아니오 로만 답해줘요.` }] };
      }

      // 6) “5문제 ㄱㄱ” → 자동 연속 출제 5회 ON
      if (wantsFive) {
        st.autoNextRemaining = 5;
        const q = await pickQuestionAvoidingRecent({ mode: st.mode, level: st.level, excludeQids: st.recentQids });
        if (!q) return { content: [{ type: "text", text: "문제를 찾지 못했습니다. questions 데이터를 확인해 주세요." }], isError: true };
        st.lastQid = String(q.q_id);
        pushRecent(st, String(q.q_id));
        return {
          content: [
            {
              type: "text",
              text: `좋아요. 연속 5문제로 진행할게요. (답을 보내면 다음 문제가 자동으로 붙어서 나옵니다)\n\n${formatQuestionText(q)}`,
            },
          ],
        };
      }

      // 7) 난이도 피드백(쉬움/어려움/적당) — “질문은 처음 1회만”
      if (isDifficultyEasy || isDifficultyHard || isDifficultyNeutral) {
        if (!st.askedDifficultyOnce) st.askedDifficultyOnce = true;

        if (isDifficultyEasy) st.level = Math.min(10, st.level + 1);
        if (isDifficultyHard) st.level = Math.max(1, st.level - 1);
        // 적당이면 그대로

        await supabase.from("users").update({ current_level: st.level }).eq("user_id", user_id);

        return {
          content: [
            {
              type: "text",
              text: `난이도 피드백 반영 완료.\n현재 설정: ${modeKo(st.mode)} ${st.level}레벨\n"다음"이라고 하면 이어서 나갑니다.`,
            },
          ],
        };
      }

      // 8) 다음 문제
      if (wantsNext) {
        const q = await pickQuestionAvoidingRecent({ mode: st.mode, level: st.level, excludeQids: st.recentQids });
        if (!q) {
          return { content: [{ type: "text", text: "문제를 찾지 못했습니다. questions 테이블을 확인해 주세요." }], isError: true };
        }
        st.lastQid = String(q.q_id);
        pushRecent(st, String(q.q_id));

        const diffAsk =
          st.askedDifficultyOnce
            ? ""
            : `\n\n(처음 한 번만 확인) 지금 난이도는 어때요? **쉬움/적당/어려움** 중 하나로 답해주면 다음부터 조정할게요.`;

        return { content: [{ type: "text", text: `${formatQuestionText(q)}${diffAsk}` }] };
      }

      // 9) 답안 제출(대화형) — 마지막 q_id로 자동 submit + 오답 자동 저장 + 5문제 자동출제
      if (isAnswerToken) {
        if (!st.lastQid) {
          return { content: [{ type: "text", text: `먼저 문제부터 받아야 해요. "다음"이라고 보내 주세요.` }] };
        }

        // 문제 조회
        const { data: q, error: qErr } = await supabase
          .from("questions")
          .select("q_id, mode, level, prompt, choices, answer, explanation, media")
          .eq("q_id", st.lastQid)
          .maybeSingle();
        if (qErr) throw qErr;
        if (!q) {
          return { content: [{ type: "text", text: "직전 문제를 찾지 못했습니다. '다음'으로 다시 받아주세요." }], isError: true };
        }

        const QQ = q as any;
        const choices = (QQ.choices ?? []) as string[];
        const graded = gradeAnswer({ choices, correctAnswer: QQ.answer, userAnswer: msg });

        // 로그 저장
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

        // 오답 자동 저장
        if (!graded.isCorrect) {
          await saveMistakeAuto({ user_id, q: QQ, graded, rawUserAnswer: msg });
        }

        // 레벨 승급 로직(해당 레벨 “연속 정답 5회” → 승급 제안)
        const currentQuestionLevel = Number(QQ.level ?? st.level);
        if (graded.isCorrect && currentQuestionLevel === st.level) {
          st.correctStreakAtLevel += 1;
        } else if (!graded.isCorrect) {
          st.correctStreakAtLevel = 0;
        }

        // feedback
        const ansRaw = String(QQ.answer ?? "").trim();
        const picked =
          graded.userPickIndex != null
            ? `${graded.userPickIndex + 1}번 (${["A", "B", "C", "D", "E"][graded.userPickIndex] ?? ""}. ${stripChoicePrefix(
                choices[graded.userPickIndex] ?? ""
              )})`
            : graded.raw;

        let feedback = `${graded.isCorrect ? "✅ 정답!" : "❌ 오답!"}
- 내 답: ${msg}
- 해석된 선택: ${picked}
- 정답: ${ansRaw}
- 해설: ${QQ.explanation ?? "(해설 없음)"}`;

        // 승급 제안
        if (st.correctStreakAtLevel >= 5 && st.level < 10) {
          st.pendingLevelUpOffer = { fromLevel: st.level, toLevel: st.level + 1 };
          st.correctStreakAtLevel = 0;

          return {
            content: [
              {
                type: "text",
                text: `${feedback}\n\n🎉 ${modeKo(st.mode)} ${st.level}레벨 클리어(연속 정답 기준)!\n다음 레벨(${st.level + 1})로 올릴까요?\n- 예 / 아니오`,
              },
            ],
          };
        }

        // “연속 5문제” 자동 다음 출제
        if (st.autoNextRemaining > 0) {
          st.autoNextRemaining = Math.max(0, st.autoNextRemaining - 1);
          if (st.autoNextRemaining > 0) {
            const nextQ = await pickQuestionAvoidingRecent({ mode: st.mode, level: st.level, excludeQids: st.recentQids });
            if (!nextQ) return { content: [{ type: "text", text: `${feedback}\n\n(다음 문제를 찾지 못했습니다)` }] };
            st.lastQid = String(nextQ.q_id);
            pushRecent(st, String(nextQ.q_id));
            return { content: [{ type: "text", text: `${feedback}\n\n${formatQuestionText(nextQ)}` }] };
          }
          // 마지막이면 종료 멘트
          return { content: [{ type: "text", text: `${feedback}\n\n✅ 연속 5문제 완료!\n원하면 "다음"으로 계속 진행하거나, "요약"/"오답노트"/"그만"을 써도 돼요.` }] };
        }

        // 일반 모드: 다음을 직접 요청하게
        return { content: [{ type: "text", text: `${feedback}\n\n다음 문제는 "다음"이라고 보내 주세요.` }] };
      }

      // 10) 기타: 가이드 메시지
      return {
        content: [
          {
            type: "text",
            text: `원하는 걸 말해줘요:
- 모드: 토익 / 문법 / 여행 / 비즈니스 / 단어
- 출제: 다음
- 답: 1~4 또는 A~D
- 요약: 요약 / 정리
- 오답: 오답노트
- 종료: 그만`,
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
    console.error("[/mcp GET] error:", err);
    safeJsonRpcError(res);
  }
});

/* --------------------------------- Listen -------------------------------- */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ MCP HTTP Server running: http://0.0.0.0:${PORT}/mcp`);
});