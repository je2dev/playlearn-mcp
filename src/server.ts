// src/server.ts
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/* ---------------------------------- Zod ---------------------------------- */
const ModeEnum = z.enum(["toeic", "grammar", "travel", "business", "vocab"]);
type Mode = z.infer<typeof ModeEnum>;

const SignalEnum = z.enum(["hard", "easy", "neutral"]).optional();

const GetUserStateArgs = z.object({
  user_id: z.string().min(1).optional(),
});

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

// ✅ 카카오 채팅용 “한 방에 처리” 도구
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

// 메시지 normalize
function normalizeMsg(s: string) {
  return s.trim().toLowerCase();
}

/* ----------------------------- Intent Parsers ----------------------------- */

// ✅ 모드 의도 파싱
function parseModeIntent(msg: string): Mode | null {
  // 한국어 / 영어 대충 다 받기
  if (msg.includes("토익") || msg.includes("toeic")) return "toeic";
  if (msg.includes("문법") || msg.includes("grammar")) return "grammar";
  if (msg.includes("회화") || msg.includes("여행") || msg.includes("travel")) return "travel";
  if (msg.includes("비즈") || msg.includes("business")) return "business";
  if (msg.includes("단어") || msg.includes("vocab") || msg.includes("어휘")) return "vocab";
  return null;
}

// ✅ 종료 의도
function isStopIntent(msg: string) {
  return ["그만", "종료", "끝", "stop", "quit", "exit", "나갈래"].some((k) => msg.includes(k));
}

// ✅ 다음 의도: 너가 원한 "ㅇㅇ/ㄱㄱ/응/yes/go/다음" 등을 다 포함
function isNextIntent(msg: string) {
  const tokens = ["ㅇㅇ", "응", "ㅇ", "그래", "ㄱㄱ", "고고", "go", "yes", "y", "다음", "next", "계속", "계속해", "더", "한문제", "한 문제"];
  return tokens.some((t) => msg === t || msg.includes(t));
}

// ✅ 복습 의도
function isReviewIntent(msg: string) {
  return ["복습", "오답", "단어", "틀린", "리뷰", "review"].some((k) => msg.includes(k));
}

// ✅ 선택지 답 파싱: "1" "A" "b" "2번" "a." 등 최대한 처리
function parseChoiceAnswer(msgRaw: string): string | null {
  const msg = msgRaw.trim();

  // "1 hard" 같이 뒤에 붙는 경우 앞 토큰만
  const first = msg.split(/\s+/)[0];

  // 숫자 1~5
  if (/^[1-5]$/.test(first)) return first;

  // 알파벳 A~E
  const up = first.toUpperCase().replace(/[^A-Z]/g, "");
  if (/^[A-E]$/.test(up)) return up;

  // "1번" "2번" 형태
  const m1 = first.match(/^([1-5])번$/);
  if (m1) return m1[1];

  // "A번" 형태
  const m2 = first.match(/^([A-Ea-e])번$/);
  if (m2) return m2[1].toUpperCase();

  return null;
}

// ✅ 난이도 피드백 파싱: 쉬워요/적당/어려워요
function parseDifficultyFeedback(msgRaw: string): "easy" | "neutral" | "hard" | null {
  const msg = msgRaw.trim().toLowerCase();

  // easy
  if (["쉬워", "쉬워요", "easy", "너무쉬움", "너무 쉬움", "쉽다", "쉽"].some((k) => msg.includes(k))) return "easy";

  // hard
  if (["어려", "어려워요", "hard", "너무어려움", "너무 어려움", "힘들", "어렵"].some((k) => msg.includes(k))) return "hard";

  // neutral
  if (["적당", "보통", "괜찮", "neutral", "중간"].some((k) => msg.includes(k))) return "neutral";

  return null;
}

/* ----------------------------- DB: ensure user ---------------------------- */

async function ensureUser(user_id: string, mode?: Mode) {
  const { data, error } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw error;
  if (data) return;

  const lastMode: Mode = mode ?? "toeic";

  // users.last_mode NOT NULL 때문에 반드시 넣음
  const { error: insErr } = await supabase.from("users").insert({
    user_id,
    current_level: 3,
    exp_points: 0,
    placement_done: false,
    last_mode: lastMode,
  });

  if (insErr) throw insErr;
}

/* --------------------------- Question / Grading --------------------------- */

// 선택지 채점 헬퍼 (1/A/B/C/D/E 다 처리)
function gradeAnswer(opts: { choices: string[]; correctAnswer: unknown; userAnswer: string }) {
  const { choices } = opts;

  const raw = String(opts.userAnswer ?? "").trim();
  const upper = raw.toUpperCase();

  const alphaMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

  let userPickIndex: number | null = null;

  // 숫자
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) userPickIndex = n - 1;
  }
  // 알파벳
  if (upper in alphaMap) userPickIndex = alphaMap[upper];

  const userPickValue =
    userPickIndex !== null && choices[userPickIndex] != null ? String(choices[userPickIndex]).trim() : raw;

  const ansStr = String(opts.correctAnswer ?? "").trim();
  const ansUpper = ansStr.toUpperCase();

  if (/^\d+$/.test(ansStr) && userPickIndex !== null) {
    const ansIndex = Number(ansStr) - 1;
    return { isCorrect: ansIndex === userPickIndex, raw, userPickIndex, userPickValue, ansStr };
  }

  if (ansStr.length === 1 && ansUpper in alphaMap && userPickIndex !== null) {
    return { isCorrect: alphaMap[ansUpper] === userPickIndex, raw, userPickIndex, userPickValue, ansStr };
  }

  const isCorrect = userPickValue.trim().toUpperCase() === ansUpper || raw.trim().toUpperCase() === ansUpper;
  return { isCorrect, raw, userPickIndex, userPickValue, ansStr };
}

// 같은 mode/level에서 랜덤 (최근 20개 중 랜덤)
async function pickRandomQuestion(mode: Mode, level: number) {
  const { data, error } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true)
    .limit(20);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx] as any;
}

// ✅ 이미 풀었던 q_id 제외하고 랜덤 선택
async function pickRandomQuestionExclude(opts: { mode: Mode; level: number; excludeQids: string[] }) {
  const { mode, level, excludeQids } = opts;

  const { data, error } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true)
    .limit(50);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const filtered = data.filter((q: any) => !excludeQids.includes(String(q.q_id)));
  const pool = filtered.length ? filtered : data; // 없으면 그냥 전체에서
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] as any;
}

function formatQuestion(q: any) {
  const choices = (q.choices ?? []) as string[];
  const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";
  const lines = choices.length ? choices.map((c: string, i: number) => `${String.fromCharCode(65 + i)}. ${c}`).join("\n") : "(선택지가 없습니다)";
  return `🧩 문제 (${q.mode} / Lv.${q.level})
${q.prompt}${mediaMd}

${lines}

정답은 **1** 또는 **A**처럼 하나만 보내줘.`;
}

/* ------------------------ Study Logs: Safe Insert ------------------------- */
/**
 * Supabase schema가 아직 확정이 아니어서(컬럼이 없거나 NOT NULL 등)
 * insert가 자주 터짐 → 가장 중요한 것만 남기며 “재시도”해서 안 죽게 처리
 */
async function safeInsertStudyLog(raw: Record<string, any>) {
  // 1) 최대 정보
  const variants: Record<string, any>[] = [
    raw,

    // 2) ref_id/event_type가 없을 수도 → 제거
    (() => {
      const { ref_id, event_type, ...rest } = raw;
      return rest;
    })(),

    // 3) mode/level/signal도 없을 수도 → 제거
    (() => {
      const { ref_id, event_type, mode, level, signal, ...rest } = raw;
      return rest;
    })(),

    // 4) 최소 필수로 추정되는 것만
    (() => {
      const keep: Record<string, any> = {};
      if (raw.user_id != null) keep.user_id = raw.user_id;
      if (raw.q_id != null) keep.q_id = raw.q_id;
      if (raw.is_correct != null) keep.is_correct = raw.is_correct;
      if (raw.user_answer != null) keep.user_answer = raw.user_answer;
      return keep;
    })(),
  ];

  let lastErr: any = null;

  for (const v of variants) {
    const { error } = await supabase.from("study_logs").insert(v);
    if (!error) return;
    lastErr = error;
  }

  // 최후: 로그 저장 실패는 학습 흐름을 막지 않게 한다(단, 서버 콘솔에 남김)
  console.warn("[study_logs] insert failed:", lastErr);
}

/* ------------------------ Practice Session Helpers ------------------------ */

type PracticeSession = {
  session_id: string;
  user_id: string;
  mode: Mode;
  level: number;
  status: "active" | "done";
  total_count: number;
  asked_count: number;
  correct_count: number;
  last_q_id: string | null;
  asked_q_ids: any; // jsonb라 any
  awaiting_answer: boolean;
  awaiting_difficulty: boolean;
  difficulty_asked_count: number;
};

async function getActivePracticeSession(user_id: string): Promise<PracticeSession | null> {
  const { data, error } = await supabase
    .from("practice_sessions")
    .select("*")
    .eq("user_id", user_id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    // practice_sessions 테이블이 없으면 여기서 터질 수 있음 → 명확히 알려주기
    throw new Error(`practice_sessions 테이블/컬럼 문제: ${safeErrorText(error)}`);
  }
  if (!data || data.length === 0) return null;
  return data[0] as any;
}

async function startPracticeSession(user_id: string, mode: Mode, level: number) {
  const session_id = randomUUID();
  const payload = {
    session_id,
    user_id,
    mode,
    level,
    status: "active",
    total_count: 10,
    asked_count: 0,
    correct_count: 0,
    last_q_id: null,
    asked_q_ids: [] as string[],
    awaiting_answer: true,
    awaiting_difficulty: false,
    difficulty_asked_count: 0,
  };

  const { error } = await supabase.from("practice_sessions").insert(payload);
  if (error) throw error;
  return session_id;
}

/* ----------------------------- Placement Config --------------------------- */
const PLACEMENT_QUESTION_COUNT = 5;

/* ------------------------------- MCP Server ------------------------------- */
const server = new McpServer({ name: "playlearn-mcp", version: "1.0.0" });

/* --------------------------- MCP: get_user_state -------------------------- */
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
        last_mode: (u?.last_mode ?? "toeic") as Mode,
      };

      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `get_user_state 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* --------------------------- Tool: placement_start ------------------------- */
server.tool(
  "placement_start",
  "진단을 시작합니다. (placement_id / q_id 포함)",
  { user_id: z.string().min(1).optional(), mode: ModeEnum },
  async (args) => {
    try {
      const parsed = PlacementStartArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const mode = parsed.mode;

      await ensureUser(user_id, mode);

      // 유저에 placement_done 초기화(진단 재시작 가능)
      await supabase.from("users").update({ placement_done: false, last_mode: mode }).eq("user_id", user_id);

      const placement_id = randomUUID();
      const startLevel = 3;

      const { error: sErr } = await supabase.from("placement_sessions").insert({
        placement_id,
        user_id,
        mode,
        is_done: false,
        asked_count: 0,
        correct_count: 0,
        current_level: startLevel,
        last_q_id: null,
      });

      if (sErr) throw sErr;

      const q = await pickRandomQuestion(mode, startLevel);
      if (!q) {
        return { content: [{ type: "text", text: "진단 문제 풀이를 위한 문제가 부족해요. questions 테이블에 문제를 더 넣어줘야 해요." }], isError: true };
      }

      await supabase.from("placement_sessions").update({ last_q_id: q.q_id }).eq("placement_id", placement_id);

      const text =
        `🧩 진단 시작 (${mode} / Lv.${startLevel})\n\n` +
        `${formatQuestion(q)}\n\n` +
        `placement_id: \`${placement_id}\`\nq_id: \`${q.q_id}\``;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_start 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* --------------------------- Tool: placement_submit ------------------------ */
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

      // 세션 확인
      const { data: s, error: sErr } = await supabase
        .from("placement_sessions")
        .select("*")
        .eq("placement_id", placement_id)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!s) return { content: [{ type: "text", text: "placement_id 세션을 찾지 못했습니다." }], isError: true };
      if ((s as any).is_done) return { content: [{ type: "text", text: "이미 완료된 진단입니다." }], isError: true };

      // 문제 조회
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices, prompt, media")
        .eq("q_id", q_id)
        .maybeSingle();
      if (qErr) throw qErr;
      if (!q) return { content: [{ type: "text", text: "문제(q_id)를 찾지 못했습니다." }], isError: true };

      const Q = q as any;
      const choices = (Q.choices ?? []) as string[];

      const graded = gradeAnswer({ choices, correctAnswer: Q.answer, userAnswer: user_answer });

      const asked = Number((s as any).asked_count ?? 0) + 1;
      const correct = Number((s as any).correct_count ?? 0) + (graded.isCorrect ? 1 : 0);

      // 레벨 규칙(간단)
      let level = Number((s as any).current_level ?? 3);
      if (graded.isCorrect) level = Math.min(10, level + 1);
      else level = Math.max(1, level - 0); // 오답은 유지(원하면 -1로 바꿔도 됨)

      const done = asked >= PLACEMENT_QUESTION_COUNT;

      // ✅ 로그 저장 (스키마 불확실 → 안전 insert)
      await safeInsertStudyLog({
        user_id,
        q_id: Q.q_id,
        user_answer: String(user_answer),
        event_type: "placement_attempt",
        ref_id: String(Q.q_id),
        mode: (s as any).mode ?? Q.mode,
        level: Number(Q.level ?? level),
        is_correct: graded.isCorrect,
        signal: signal ?? "neutral",
      });

      // 세션 업데이트
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

      if (done) {
        const { error: uUpErr } = await supabase
          .from("users")
          .update({
            current_level: level,
            placement_done: true,
            last_mode: ((s as any).mode ?? Q.mode ?? "toeic") as Mode,
          })
          .eq("user_id", user_id);
        if (uUpErr) throw uUpErr;

        return {
          content: [
            {
              type: "text",
              text:
`✅ 진단 완료!
- 정답: ${correct}/${PLACEMENT_QUESTION_COUNT}
- 최종 레벨: Lv.${level}

이제부터는 이 레벨 기준으로 10문제 세트를 풀어보자.
"토익공부" 또는 "계속"이라고 말해줘.`,
            },
          ],
        };
      }

      // 다음 문제
      const mode = ((s as any).mode ?? "toeic") as Mode;
      const nq = await pickRandomQuestion(mode, level);
      if (!nq) {
        return { content: [{ type: "text", text: "다음 문제가 부족해요. questions 테이블에 문제를 더 넣어줘야 해요." }], isError: true };
      }

      await supabase
        .from("placement_sessions")
        .update({ last_q_id: nq.q_id })
        .eq("placement_id", placement_id);

      return {
        content: [
          {
            type: "text",
            text:
`${graded.isCorrect ? "✅ 정답" : "❌ 오답"}
- 내 답: ${String(user_answer).trim()}
- 정답: ${String(Q.answer ?? "").trim()}
- 해설: ${Q.explanation ?? "(해설 없음)"}

${formatQuestion(nq)}

placement_id: \`${placement_id}\`
q_id: \`${nq.q_id}\``,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_submit 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------- Tool: get_question ------------------------------- */
server.tool(
  "get_question",
  "모드/레벨에 맞는 활성(is_active=true) 객관식 문제 1개를 가져옵니다.",
  { mode: ModeEnum, level: z.number().int().min(1).max(10) },
  async (args) => {
    try {
      const { mode, level } = GetQuestionArgs.parse(args);

      const q = await pickRandomQuestion(mode, level);
      if (!q) {
        return { content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다." }] };
      }

      return { content: [{ type: "text", text: `${formatQuestion(q)}\n\nq_id: \`${q.q_id}\`` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `get_question 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------- Tool: submit_answer ------------------------------- */
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장",
  {
    user_id: z.string().min(1).optional(),
    q_id: z.string().uuid(),
    user_answer: z.string().min(1),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const parsed = SubmitAnswerArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const { q_id, user_answer, signal } = parsed;

      await ensureUser(user_id, "toeic");

      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices")
        .eq("q_id", q_id)
        .maybeSingle();
      if (qErr) throw qErr;
      if (!q) return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }], isError: true };

      const Q = q as any;
      const choices = (Q.choices ?? []) as string[];

      const graded = gradeAnswer({
        choices,
        correctAnswer: Q.answer,
        userAnswer: user_answer,
      });

      // ✅ NOT NULL user_answer 대응 + schema cache 문제 대응(안전 insert)
      await safeInsertStudyLog({
        user_id,
        q_id: Q.q_id,
        user_answer: String(user_answer),
        event_type: "quiz_attempt",
        ref_id: String(Q.q_id),
        mode: Q.mode,
        level: Number(Q.level ?? 3),
        is_correct: graded.isCorrect,
        signal: signal ?? "neutral",
      });

      const text =
`${graded.isCorrect ? "✅ 정답" : "❌ 오답"}
- 내 답: ${String(user_answer).trim()}
- 정답: ${String(Q.answer ?? "").trim()}
- 해설: ${Q.explanation ?? "(해설 없음)"}`;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* -------------------------- Tool: handle_user_message -------------------------- */
server.tool(
  "handle_user_message",
  "카카오 채팅 입력을 받아 의도를 판단하고(답/다음/난이도/종료/복습) 적절한 학습 흐름을 진행합니다.",
  { user_id: z.string().min(1).optional(), message: z.string().min(1) },
  async (args) => {
    try {
      const parsed = HandleUserMessageArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const msg = normalizeMsg(parsed.message);

      // 0) 유저 보장
      const modeIntent = parseModeIntent(msg);
      await ensureUser(user_id, modeIntent ?? "toeic");

      // 1) 유저 상태 로드
      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("user_id, current_level, placement_done, last_mode")
        .eq("user_id", user_id)
        .maybeSingle();
      if (uErr) throw uErr;

      const currentLevel = Number((u as any)?.current_level ?? 3);
      const lastMode: Mode = (((u as any)?.last_mode ?? "toeic") as Mode);

      // 2) 종료
      if (isStopIntent(msg)) {
        const s = await getActivePracticeSession(user_id);
        if (!s) {
          return { content: [{ type: "text", text: "오케이. 오늘은 여기까지! 다음에 이어서 할 때는 “토익공부”처럼 말해줘 🙂" }] };
        }

        const accuracy = s.asked_count ? Math.round((s.correct_count / s.asked_count) * 100) : 0;
        await supabase.from("practice_sessions").update({ status: "done" }).eq("session_id", s.session_id);

        return {
          content: [{
            type: "text",
            text:
`✅ 오늘 학습 요약
- 모드: ${s.mode}
- 레벨: Lv.${s.level}
- 푼 문제: ${s.asked_count}/${s.total_count}
- 정답: ${s.correct_count}
- 정답률: ${accuracy}%

원하면 이렇게 말해줘:
1) “계속” (새 10문제)
2) “복습” (오답/단어)
3) “다른 공부” (문법/회화/단어 등)`
          }]
        };
      }

      // 3) 복습
      if (isReviewIntent(msg)) {
        return {
          content: [{
            type: "text",
            text: `복습 모드로 갈게요.\n“오답” 또는 “단어” 중 뭐부터 할까요?\n예) “오답 복습”`
          }]
        };
      }

      // 4) active 세션 로드 (없으면 새로 시작)
      let s = await getActivePracticeSession(user_id);

      if (!s) {
        const modeToUse = modeIntent ?? lastMode ?? "toeic";
        const levelToUse = currentLevel;

        const sid = await startPracticeSession(user_id, modeToUse, levelToUse);

        const q = await pickRandomQuestionExclude({
          mode: modeToUse,
          level: levelToUse,
          excludeQids: [],
        });

        if (!q) {
          return { content: [{ type: "text", text: "문제가 부족해요. questions 테이블에 문제를 더 넣어줘야 해요." }], isError: true };
        }

        await supabase.from("practice_sessions").update({
          last_q_id: q.q_id,
          asked_q_ids: [q.q_id],
          awaiting_answer: true,
          awaiting_difficulty: false,
        }).eq("session_id", sid);

        return {
          content: [{
            type: "text",
            text:
`좋아. Lv.${levelToUse}로 **10문제** 풀어보자.
(중간에 “그만” 하면 요약해줄게)

${formatQuestion(q)}`
          }]
        };
      }

      // 5) 난이도 피드백 기다리는 상태
      if (s.awaiting_difficulty) {
        const fb = parseDifficultyFeedback(msg);
        if (!fb) {
          return { content: [{ type: "text", text: `난이도만 골라줘 🙂\n예) 쉬워요 / 적당해요 / 어려워요` }] };
        }

        // 난이도 반영: easy면 +1, hard면 -1, neutral 유지
        let newLevel = Number(s.level);
        if (fb === "easy") newLevel = Math.min(10, newLevel + 1);
        if (fb === "hard") newLevel = Math.max(1, newLevel - 1);

        const askedCnt = Number(s.difficulty_asked_count ?? 0) + 1;
        const askDifficultyAgain = askedCnt < 2; // 2번까지만

        await supabase.from("practice_sessions").update({
          level: newLevel,
          awaiting_difficulty: false,
          awaiting_answer: true,
          difficulty_asked_count: askedCnt,
        }).eq("session_id", s.session_id);

        // 다음 문제
        const exclude = Array.isArray(s.asked_q_ids) ? (s.asked_q_ids as any[]).map(String) : [];
        const q = await pickRandomQuestionExclude({ mode: s.mode, level: newLevel, excludeQids: exclude });

        if (!q) {
          return { content: [{ type: "text", text: "다음 문제가 부족해요. questions 테이블에 문제를 더 넣어줘야 해요." }], isError: true };
        }

        const newAskedQids = [...exclude, String(q.q_id)];

        await supabase.from("practice_sessions").update({
          last_q_id: q.q_id,
          asked_q_ids: newAskedQids,
        }).eq("session_id", s.session_id);

        const tail = askDifficultyAgain
          ? `\n(난이도는 앞으로 한 번 더만 물어볼게)`
          : `\n(이제부터는 난이도 질문 없이 쭉 갈게. 조절하고 싶으면 중간에 “어려워요/쉬워요”라고 말해도 돼)`;

        return { content: [{ type: "text", text: `오케이. 반영했어 → **Lv.${newLevel}**${tail}\n\n${formatQuestion(q)}` }] };
      }

      // 6) 답 처리
      const answer = parseChoiceAnswer(parsed.message);
      if (answer) {
        const qid = String(s.last_q_id ?? "");
        if (!qid) return { content: [{ type: "text", text: "현재 문제 상태가 꼬였어. “토익공부”라고 다시 말해줘." }], isError: true };

        const { data: q, error: qErr } = await supabase
          .from("questions")
          .select("q_id, mode, level, answer, explanation, choices")
          .eq("q_id", qid)
          .maybeSingle();
        if (qErr) throw qErr;
        if (!q) return { content: [{ type: "text", text: "문제를 찾지 못했어. “토익공부”라고 다시 말해줘." }], isError: true };

        const Q = q as any;
        const choices = (Q.choices ?? []) as string[];

        const graded = gradeAnswer({ choices, correctAnswer: Q.answer, userAnswer: answer });

        const asked = Number(s.asked_count ?? 0) + 1;
        const correct = Number(s.correct_count ?? 0) + (graded.isCorrect ? 1 : 0);
        const isLast = asked >= Number(s.total_count ?? 10);

        // 로그
        await safeInsertStudyLog({
          user_id,
          q_id: Q.q_id,
          user_answer: String(answer),
          event_type: "quiz_attempt",
          ref_id: String(Q.q_id),
          mode: Q.mode,
          level: Number(Q.level ?? s.level),
          is_correct: graded.isCorrect,
          signal: "neutral",
        });

        const needDifficultyAsk = Number(s.difficulty_asked_count ?? 0) < 2;

        await supabase.from("practice_sessions").update({
          asked_count: asked,
          correct_count: correct,
          awaiting_answer: false,
          awaiting_difficulty: needDifficultyAsk && !isLast,
          last_explanation: String(Q.explanation ?? ""),
        } as any).eq("session_id", s.session_id);

        const resultBlock =
`${graded.isCorrect ? "✅ 정답" : "❌ 오답"}
- 내 답: ${answer}
- 정답: ${String(Q.answer ?? "")}
- 해설: ${Q.explanation ?? "(해설 없음)"}`;

        // 마지막이면 요약
        if (isLast) {
          const accuracy = asked ? Math.round((correct / asked) * 100) : 0;

          await supabase.from("practice_sessions").update({
            status: "done",
            awaiting_answer: false,
            awaiting_difficulty: false,
          }).eq("session_id", s.session_id);

          return {
            content: [{
              type: "text",
              text:
`${resultBlock}

✅ 오늘 학습 요약 (10문제)
- 모드: ${s.mode}
- 레벨: Lv.${s.level}
- 정답: ${correct}/10
- 정답률: ${accuracy}%

다음은 뭐 할까?
1) “한 세트 더” (10문제 추가)
2) “복습”
3) “다른 공부”`
            }]
          };
        }

        // 1~2문제까지만 난이도 질문
        if (needDifficultyAsk) {
          return {
            content: [{
              type: "text",
              text:
`${resultBlock}

난이도는 어땠어?
예) 쉬워요 / 적당해요 / 어려워요`
            }]
          };
        }

        // 3문제 이후: 다음 진행을 ㅇㅇ/ㄱㄱ로 받기
        return {
          content: [{
            type: "text",
            text:
`${resultBlock}

다음 문제 갈까? (ㅇㅇ / ㄱㄱ / 다음)`
          }]
        };
      }

      // 7) 다음 의도
      if (isNextIntent(msg)) {
        const exclude = Array.isArray(s.asked_q_ids) ? (s.asked_q_ids as any[]).map(String) : [];
        const q = await pickRandomQuestionExclude({ mode: s.mode, level: Number(s.level), excludeQids: exclude });

        if (!q) return { content: [{ type: "text", text: "다음 문제가 부족해요. questions 테이블에 문제를 더 넣어줘야 해요." }], isError: true };

        await supabase.from("practice_sessions").update({
          last_q_id: q.q_id,
          asked_q_ids: [...exclude, String(q.q_id)],
          awaiting_answer: true,
          awaiting_difficulty: false,
        }).eq("session_id", s.session_id);

        return { content: [{ type: "text", text: formatQuestion(q) }] };
      }

      // 8) 자발적 난이도 피드백(3문제 이후도 허용)
      const fb2 = parseDifficultyFeedback(parsed.message);
      if (fb2) {
        let newLevel = Number(s.level);
        if (fb2 === "easy") newLevel = Math.min(10, newLevel + 1);
        if (fb2 === "hard") newLevel = Math.max(1, newLevel - 1);

        await supabase.from("practice_sessions").update({ level: newLevel }).eq("session_id", s.session_id);
        return { content: [{ type: "text", text: `오케이. 다음 문제부터 난이도 조정할게 → **Lv.${newLevel}**\n(다음 문제는 “ㅇㅇ/ㄱㄱ/다음”이라고 말하면 바로 나가요)` }] };
      }

      // 9) 안내
      return {
        content: [{
          type: "text",
          text: `답은 **1** 또는 **A**처럼 하나만 보내면 돼.\n다음 문제는 “ㅇㅇ / ㄱㄱ / 다음”이라고 말해도 넘어가.\n끝낼 땐 “그만”.`
        }]
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
const serverConnectedForSession: Record<string, boolean> = {};

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    if (!mustAcceptSseAndJson(req)) {
      res.status(406).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Not Acceptable: Client must accept both application/json and text/event-stream" },
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

      // ✅ 중요: connect는 세션당 1회만
      await server.connect(transport);
      serverConnectedForSession[newSessionId] = true;

      res.setHeader("mcp-session-id", newSessionId);
    } else {
      sessionsLastSeen[incomingSessionId] = Date.now();
      if (!serverConnectedForSession[incomingSessionId]) {
        await server.connect(transport);
        serverConnectedForSession[incomingSessionId] = true;
      }
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
        error: { code: -32000, message: "Not Acceptable: Client must accept both application/json and text/event-stream" },
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