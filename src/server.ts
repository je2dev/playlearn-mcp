// index.ts
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
  user_id: z.string().min(1).optional(), // ✅ optional (kakao demo)
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
  // ✅ payload 없는 호출도 허용 (카카오에서 key만 보내는 케이스)
  payload: z.record(z.string(), z.unknown()).optional().default({}),
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

/* ------------------------------ Chat Orchestrator ------------------------------ */
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

/* --------------------------- KST day helpers --------------------------- */
function kstDayStartIso(date = new Date()) {
  // KST = UTC+9
  const utcMs = date.getTime();
  const kstMs = utcMs + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);

  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();

  // KST 00:00 -> UTC time = KST - 9h
  const kstStartUtcMs = Date.UTC(y, m, d, 0, 0, 0) - 9 * 60 * 60 * 1000;
  return new Date(kstStartUtcMs).toISOString();
}

function normalizeText(s: string) {
  return String(s ?? "").trim();
}

/* ----------------------- Strict answer parsing (fix "12") ----------------------- */
/**
 * ✅ 정답 입력을 "단일 토큰"만 허용:
 * - 숫자: 1~5 (한 자리만)
 * - 알파벳: A~E (한 글자만)
 * - 그 외: 텍스트(주관식처럼) (선택지 비교용)
 *
 * "12" 같은 입력은 숫자로 취급하지 않음 → 그대로 텍스트로 남아 오답 처리됨.
 */
function parseSingleChoiceToken(rawInput: string) {
  const raw = normalizeText(rawInput);
  const upper = raw.toUpperCase();

  // 숫자 한 자리만 허용 (1~5)
  if (/^[1-5]$/.test(raw)) {
    return { kind: "index" as const, index: Number(raw) - 1, raw };
  }

  // 알파벳 한 글자만 허용 (A~E)
  if (/^[A-E]$/.test(upper)) {
    const alphaMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };
    return { kind: "index" as const, index: alphaMap[upper], raw };
  }

  return { kind: "text" as const, text: raw, raw };
}

// 선택지 채점 헬퍼 (엄격 토큰 + 텍스트 비교)
function gradeAnswer(opts: {
  choices: string[];
  correctAnswer: unknown;
  userAnswer: string;
}) {
  const { choices } = opts;

  const token = parseSingleChoiceToken(opts.userAnswer);
  const ansStr = normalizeText(String(opts.correctAnswer ?? ""));
  const ansUpper = ansStr.toUpperCase();

  let userPickIndex: number | null = null;
  let userPickValue: string = token.raw;

  if (token.kind === "index") {
    userPickIndex = token.index;
    userPickValue =
      choices[userPickIndex] != null ? normalizeText(String(choices[userPickIndex])) : token.raw;
  } else {
    userPickIndex = null;
    userPickValue = token.text;
  }

  // 정답이 "1"~"5" 처럼 숫자 인덱스인 경우
  if (/^[1-5]$/.test(ansStr) && userPickIndex !== null) {
    const ansIndex = Number(ansStr) - 1;
    return {
      isCorrect: ansIndex === userPickIndex,
      raw: token.raw,
      userPickIndex,
      userPickValue,
      ansStr,
    };
  }

  // 정답이 "A"~"E" 알파벳인 경우
  if (/^[A-E]$/.test(ansUpper) && userPickIndex !== null) {
    const alphaMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };
    return {
      isCorrect: alphaMap[ansUpper] === userPickIndex,
      raw: token.raw,
      userPickIndex,
      userPickValue,
      ansStr,
    };
  }

  // 그 외에는 텍스트 비교
  const isCorrect =
    normalizeText(userPickValue).toUpperCase() === ansUpper ||
    normalizeText(token.raw).toUpperCase() === ansUpper;

  return { isCorrect, raw: token.raw, userPickIndex, userPickValue, ansStr };
}

/* ----------------------------- Anti-repeat picking ----------------------------- */
const RECENT_EXCLUDE_COUNT = 20;

/**
 * user_id가 있으면 최근 풀이한 q_id를 제외하고 랜덤 픽
 * (DB가 적어서 중복될 수 있으니, 그래도 없으면 레벨 클리어 트리거용으로 null 리턴)
 */
async function pickRandomQuestionForUser(params: {
  user_id?: string;
  mode: Mode;
  level: number;
}) {
  const { user_id, mode, level } = params;

  let excludeIds: string[] = [];

  if (user_id) {
    const { data: recent, error: rErr } = await supabase
      .from("study_logs")
      .select("q_id, created_at")
      .eq("user_id", user_id)
      .eq("mode", mode)
      .order("created_at", { ascending: false })
      .limit(RECENT_EXCLUDE_COUNT);

    if (rErr) throw rErr;
    excludeIds = (recent ?? []).map((x: any) => String(x.q_id));
  }

  let query = supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true)
    .limit(50);

  if (excludeIds.length) query = query.not("q_id", "in", `(${excludeIds.join(",")})`);

  const { data, error } = await query;
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx] as any;
}

/**
 * 레벨 내 활성 문제 수 / 유저가 푼 문제 수를 비교해서 "고갈"인지 판단
 */
async function isLevelExhausted(user_id: string, mode: Mode, level: number) {
  const { count: totalCount, error: tErr } = await supabase
    .from("questions")
    .select("*", { count: "exact", head: true })
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true);

  if (tErr) throw tErr;

  const { data: solved, error: sErr } = await supabase
    .from("study_logs")
    .select("q_id")
    .eq("user_id", user_id)
    .eq("mode", mode)
    .eq("event_type", "quiz_attempt")
    .eq("level", level);

  if (sErr) throw sErr;

  const solvedUnique = new Set((solved ?? []).map((x: any) => String(x.q_id))).size;
  const total = Number(totalCount ?? 0);

  // total이 너무 적으면 (예: 0/1/2문제) 클리어 판정이 너무 빨리 될 수 있으니 보호
  if (total <= 0) return { exhausted: true, total, solvedUnique };
  return { exhausted: solvedUnique >= total, total, solvedUnique };
}

/* ----------------------------- One-time difficulty message ----------------------------- */
const difficultyPromptShown: Record<string, boolean> = {};

/* ----------------------------- Pending state (level clear / menu) ----------------------------- */
type PendingState =
  | { type: "level_clear"; mode: Mode; level: number }
  | { type: "post_clear_menu"; mode: Mode; level: number };

const pending: Record<string, PendingState | undefined> = {};

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
      return {
        content: [{ type: "text", text: `get_user_state 실패: ${safeErrorText(e)}` }],
        isError: true,
      };
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
        return {
          content: [{ type: "text", text: "문제(q_id)를 찾지 못했습니다." }],
          isError: true,
        };
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
          .update({ current_level: level, placement_done: true, last_mode: mode })
          .eq("user_id", user_id);
        if (uUpErr) throw uUpErr;

        const text = `✅ 레벨 진단 완료!

- 맞힌 문제: ${correct}/${asked}
- 최종 레벨: Lv.${level}

이제 이 레벨 기준으로 문제를 풀 수 있어요.
"시작" 또는 "다음"이라고 보내면 바로 문제를 낼게요.`;
        return { content: [{ type: "text", text }] };
      }

      // 7) 다음 문제
      const nextQ = await pickRandomQuestionForUser({ user_id, mode, level });
      if (!nextQ) {
        return {
          content: [{ type: "text", text: "다음 문제를 찾지 못했습니다. (DB에 문제를 더 추가해 주세요)" }],
          isError: true,
        };
      }

      const nChoices = (nextQ.choices ?? []) as string[];
      const mediaMd = nextQ.media?.image ? `\n\n![image](${nextQ.media.image})\n` : "";

      const feedback = `${graded.isCorrect ? "✅ 정답!" : "❌ 오답!"}
- 내가 보낸 답: ${graded.raw}
- 정답: ${graded.ansStr}
- 해설: ${Q.explanation ?? "(해설 없음)"}

현재 임시 레벨: Lv.${level}
`;

      const nextText = `🧩 ${nextQ.mode.toUpperCase()} Lv.${nextQ.level}
${nextQ.prompt}${mediaMd}

${
  nChoices.length ? nChoices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"
}

q_id: \`${nextQ.q_id}\`

정답은 **숫자(1~)** 또는 **A~E**로 보내 주세요.`;

      return { content: [{ type: "text", text: `${feedback}\n\n${nextText}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_submit 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------ Tool: get_question ------------------------------ */
server.tool(
  "get_question",
  "모드/레벨에 맞는 활성(is_active=true) 객관식 문제 1개를 가져옵니다. (가능하면 중복 제외)",
  { user_id: z.string().optional(), mode: ModeEnum, level: z.number().int().min(1).max(10) },
  async (args) => {
    const parsed = GetQuestionArgs.parse(args);
    const user_id = parsed.user_id ? resolveUserId(parsed.user_id) : undefined;
    const { mode, level } = parsed;

    if (user_id) await ensureUser(user_id, mode);

    const q = await pickRandomQuestionForUser({ user_id, mode, level });

    if (!q) {
      // user_id가 있으면 레벨 고갈 체크 후 안내
      if (user_id) {
        const ex = await isLevelExhausted(user_id, mode, level);
        if (ex.exhausted) {
          pending[user_id] = { type: "level_clear", mode, level };
          const text = `🎉 ${mode.toUpperCase()} Lv.${level} 레벨 문제를 모두 풀었어요! (활성 문제 ${ex.total}개 / 풀이 ${ex.solvedUnique}개)

다음 레벨(Lv.${Math.min(10, level + 1)})로 넘어갈까요?
- ㅇㅇ : 다음 레벨로 이동
- ㄴㄴ : Lv.${level} 복습 / 다른 모드 선택`;
          return { content: [{ type: "text", text }] };
        }
      }

      return {
        content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다. (DB에 문제 추가 필요)" }],
      };
    }

    const choices = (q.choices ?? []) as string[];
    const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

    const header = `🧩 ${String(q.mode).toUpperCase()} Lv.${Number(q.level)}`;

    const text = `${header}
${q.prompt}${mediaMd}

${
  choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"
}

q_id: \`${q.q_id}\`

정답은 **숫자(1~)** 또는 **A~E**로 보내 주세요.`;

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: submit_answer ------------------------------- */
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장 (난이도 멘트는 반복하지 않음)",
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
      const ansRaw = normalizeText(String(QQ.answer ?? ""));

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

      // (선택) 오답이면 자동 오답노트 후보로 저장해두고 싶다면 여기서 save_item 해도 됨.
      // 지금은 "오답노트" 요청 시 study_logs 기반으로 뽑기 때문에 필수 아님.

      const dbgPicked =
        graded.userPickIndex != null
          ? `${graded.userPickIndex + 1}번${choices[graded.userPickIndex] ? ` (${choices[graded.userPickIndex]})` : ""}`
          : graded.raw;

      const header = `🧩 ${String(QQ.mode).toUpperCase()} Lv.${Number(QQ.level)}`;

      const text = `${graded.isCorrect ? "✅ 정답입니다!" : "❌ 오답입니다."}

${header}
- 내가 보낸 답: ${normalizeText(String(user_answer))}
- 해석된 선택: ${dbgPicked}
- 정답(저장값): ${ansRaw}
- 해설: ${QQ.explanation ?? "(해설 없음)"}

다음 문제는 "다음"이라고 보내 주세요.`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(err)}` }], isError: true };
    }
  }
);

/* ------------------------------- Tool: save_item ------------------------------- */
server.tool(
  "save_item",
  "단어/오답/메모를 review_items에 저장합니다. (payload 없으면 빈 객체로 저장)",
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
        ? "\n" +
          data
            .map(
              (it: any, idx: number) =>
                `${idx + 1}) [${it.item_type}] **${it.key}**\n- payload: ${JSON.stringify(it.payload)}`
            )
            .join("\n")
        : "\n(없음)");

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: get_learning_summary ------------------------------- */
/**
 * ✅ 유저 요청대로 "요약/정리"는 문제+답+설명까지 포함해야 해서,
 * 기존의 숫자 요약은 유지하되, handle_user_message에서 "요약/정리" 키워드가 오면
 * 오늘 푼 문제 전체를 상세로 뽑아 보내도록 함.
 */
server.tool(
  "get_learning_summary",
  "기간(최근 N일) 기반 학습 요약(숫자 요약)만 제공합니다.",
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

/* ------------------------------- Chat: today's full summary ------------------------------- */
async function buildTodayFullSummary(user_id: string, opts?: { onlyWrong?: boolean }) {
  const since = kstDayStartIso(new Date());

  const logsQ = supabase
    .from("study_logs")
    .select("q_id, mode, level, is_correct, user_answer, created_at")
    .eq("user_id", user_id)
    .eq("event_type", "quiz_attempt")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (opts?.onlyWrong) logsQ.eq("is_correct", false);

  const { data: logs, error: lErr } = await logsQ;
  if (lErr) throw lErr;

  if (!logs || logs.length === 0) {
    return {
      logs: [],
      text: opts?.onlyWrong ? "오늘 오답이 없습니다." : "오늘 푼 문제가 없습니다.",
    };
  }

  const qIds = Array.from(new Set(logs.map((x: any) => String(x.q_id))));
  const { data: qs, error: qErr } = await supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation")
    .in("q_id", qIds);

  if (qErr) throw qErr;

  const qMap = new Map<string, any>();
  (qs ?? []).forEach((q: any) => qMap.set(String(q.q_id), q));

  const lines: string[] = [];

  lines.push(opts?.onlyWrong ? "📌 오늘 오답노트" : "📌 오늘 공부 정리(문제+정답+해설)");

  logs.forEach((lg: any, idx: number) => {
    const q = qMap.get(String(lg.q_id));
    if (!q) return;

    const mode = String(q.mode ?? lg.mode ?? "").toUpperCase();
    const level = Number(q.level ?? lg.level ?? 0);
    const prompt = String(q.prompt ?? "");
    const choices = (q.choices ?? []) as string[];
    const ans = String(q.answer ?? "");
    const exp = String(q.explanation ?? "(해설 없음)");
    const ua = String(lg.user_answer ?? "");
    const correctMark = lg.is_correct ? "✅" : "❌";

    lines.push(
      `\n${idx + 1}) ${correctMark} ${mode} Lv.${level}\n` +
        `${prompt}\n` +
        `${choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지 없음)"}\n` +
        `- 내 답: ${ua}\n` +
        `- 정답: ${ans}\n` +
        `- 해설: ${exp}\n` +
        `- q_id: \`${q.q_id}\``
    );
  });

  return { logs, text: lines.join("\n") };
}

/* ------------------------------- Similar review question ------------------------------- */
async function pickSimilarQuestion(params: {
  user_id: string;
  mode: Mode;
  level: number;
  excludeQids: string[];
}) {
  const { user_id, mode, level, excludeQids } = params;

  let query = supabase
    .from("questions")
    .select("q_id, mode, level, prompt, choices, answer, explanation, media")
    .eq("mode", mode)
    .eq("level", level)
    .eq("is_active", true)
    .limit(50);

  if (excludeQids.length) query = query.not("q_id", "in", `(${excludeQids.join(",")})`);

  const { data, error } = await query;
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx] as any;
}

/* ------------------------------- Tool: handle_user_message ------------------------------- */
server.tool(
  "handle_user_message",
  "사용자 메시지(자연어)로 학습 흐름을 제어합니다. (난이도 1회 안내, 요약/정리, 오답노트, 레벨 클리어, 다음 문제 등)",
  { user_id: z.string().optional(), message: z.string() },
  async (args) => {
    try {
      const parsed = HandleUserMessageArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const message = normalizeText(parsed.message);

      await ensureUser(user_id, "toeic");

      // 유저 상태
      const { data: uRow, error: uErr } = await supabase
        .from("users")
        .select("current_level, last_mode, placement_done")
        .eq("user_id", user_id)
        .maybeSingle();
      if (uErr) throw uErr;

      const currentLevel = Number((uRow as any)?.current_level ?? 3);
      const lastMode = ((uRow as any)?.last_mode ?? "toeic") as Mode;

      // -------------------- 0) "그만" => 자동 오답노트(오늘) --------------------
      if (/^(그만|종료|끝|스톱|stop)$/i.test(message)) {
        const wrong = await buildTodayFullSummary(user_id, { onlyWrong: true });
        return {
          content: [
            {
              type: "text",
              text: `${wrong.text}\n\n(원하면) "오답 복습"이라고 보내면 비슷한 문제로 바로 확인할게요.`,
            },
          ],
        };
      }

      // -------------------- 1) Pending: 레벨 클리어 질문 응답 --------------------
      const p = pending[user_id];

      if (p?.type === "level_clear") {
        if (/^(ㅇㅇ|ㅇ|yes|y)$/i.test(message)) {
          const nextLevel = Math.min(10, p.level + 1);

          await supabase
            .from("users")
            .update({ current_level: nextLevel, last_mode: p.mode })
            .eq("user_id", user_id);

          pending[user_id] = undefined;

          const q = await pickRandomQuestionForUser({ user_id, mode: p.mode, level: nextLevel });
          if (!q) {
            pending[user_id] = { type: "level_clear", mode: p.mode, level: nextLevel };
            return {
              content: [
                {
                  type: "text",
                  text: `🎉 ${p.mode.toUpperCase()} Lv.${nextLevel} 문제도 지금은 더 이상 출제할 게 없어요.\nDB에 문제를 더 추가해 주세요.`,
                },
              ],
            };
          }

          const choices = (q.choices ?? []) as string[];
          const header = `🧩 ${String(q.mode).toUpperCase()} Lv.${Number(q.level)}`;
          const text = `👍 좋아요! ${p.mode.toUpperCase()} Lv.${nextLevel}로 이동했어요.\n\n${header}\n${q.prompt}\n\n${
            choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지 없음)"
          }\n\nq_id: \`${q.q_id}\`\n\n정답은 **숫자(1~)** 또는 **A~E**로 보내 주세요.`;
          return { content: [{ type: "text", text }] };
        }

        if (/^(ㄴㄴ|ㄴ|no|n)$/i.test(message)) {
          pending[user_id] = { type: "post_clear_menu", mode: p.mode, level: p.level };
          return {
            content: [
              {
                type: "text",
                text: `알겠어요.\n\n1) Lv.${p.level} 복습(오늘 오답 중심)\n2) 다른 모드(토익/문법/단어/여행/비즈니스)\n\n원하는 걸 숫자로 보내 주세요: 1 또는 2`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `다음 레벨로 갈지 선택해 주세요.\n- ㅇㅇ : 다음 레벨\n- ㄴㄴ : 복습/다른 모드`,
            },
          ],
        };
      }

      if (p?.type === "post_clear_menu") {
        if (/^1$/.test(message)) {
          pending[user_id] = undefined;
          const wrong = await buildTodayFullSummary(user_id, { onlyWrong: true });
          return {
            content: [
              {
                type: "text",
                text: `${wrong.text}\n\n"오답 복습"이라고 보내면 비슷한 문제로 바로 확인할게요.`,
              },
            ],
          };
        }
        if (/^2$/.test(message)) {
          pending[user_id] = undefined;
          return {
            content: [
              {
                type: "text",
                text: `어떤 모드로 할까요?\n- toeic / grammar / vocab / travel / business\n예) "단어" 또는 "vocab"`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `1 또는 2로 선택해 주세요.\n1) Lv.${p.level} 복습\n2) 다른 모드`,
            },
          ],
        };
      }

      // -------------------- 2) 모드 전환 --------------------
      const modeMap: Record<string, Mode> = {
        토익: "toeic",
        toeic: "toeic",
        문법: "grammar",
        grammar: "grammar",
        여행: "travel",
        travel: "travel",
        비즈니스: "business",
        business: "business",
        단어: "vocab",
        vocab: "vocab",
      };

      const modeKey = Object.keys(modeMap).find((k) => message.toLowerCase() === k.toLowerCase());
      if (modeKey) {
        const m = modeMap[modeKey];
        await supabase.from("users").update({ last_mode: m }).eq("user_id", user_id);

        const q = await pickRandomQuestionForUser({ user_id, mode: m, level: currentLevel });
        if (!q) {
          pending[user_id] = { type: "level_clear", mode: m, level: currentLevel };
          return {
            content: [
              {
                type: "text",
                text: `지금 ${m.toUpperCase()} Lv.${currentLevel}에서 낼 문제가 부족해요.\n다음 레벨로 갈까요?\n- ㅇㅇ / ㄴㄴ`,
              },
            ],
          };
        }

        const choices = (q.choices ?? []) as string[];
        const header = `🧩 ${String(q.mode).toUpperCase()} Lv.${Number(q.level)}`;
        const text = `모드를 ${m.toUpperCase()}로 바꿨어요.\n\n${header}\n${q.prompt}\n\n${
          choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지 없음)"
        }\n\nq_id: \`${q.q_id}\`\n\n정답은 **숫자(1~)** 또는 **A~E**로 보내 주세요.`;
        return { content: [{ type: "text", text }] };
      }

      // -------------------- 3) 난이도 신호(쉬워요/어려워요) --------------------
      // "정답 1 + 쉬워요" 같이 와도 처리되도록, 메시지 안에 포함되면 signal로 반영
      const hasEasy = /쉬워요|쉬움|easy/i.test(message);
      const hasHard = /어려워요|어려움|hard/i.test(message);

      // -------------------- 4) 오늘 정리/요약 --------------------
      if (/(요약|정리)\s*$/i.test(message) || /(오늘.*(요약|정리))/i.test(message)) {
        const sum = await buildTodayFullSummary(user_id, { onlyWrong: false });
        return { content: [{ type: "text", text: sum.text }] };
      }

      // -------------------- 5) 오답노트 --------------------
      if (/(오답노트|오답\s*정리|틀린문제|오늘\s*오답)/i.test(message)) {
        const wrong = await buildTodayFullSummary(user_id, { onlyWrong: true });

        // 오답이 있으면 "유사문제 복습"까지 이어주기
        if (wrong.logs.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `${wrong.text}\n\n"오답 복습"이라고 보내면 비슷한 문제로 바로 확인할게요.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: wrong.text }] };
      }

      if (/(오답\s*복습)/i.test(message)) {
        // 오늘 오답 중 첫 번째 기준으로 유사 문제 1개 출제
        const wrong = await buildTodayFullSummary(user_id, { onlyWrong: true });
        if (wrong.logs.length === 0) {
          return { content: [{ type: "text", text: "오늘 오답이 없어서 복습 문제를 낼 게 없어요." }] };
        }

        const first = wrong.logs.find((x: any) => x.is_correct === false) as any;
        const mode = (first?.mode ?? lastMode) as Mode;
        const level = Number(first?.level ?? currentLevel);
        const exclude = wrong.logs.map((x: any) => String(x.q_id));

        const sim = await pickSimilarQuestion({ user_id, mode, level, excludeQids: exclude });
        if (!sim) {
          return {
            content: [
              {
                type: "text",
                text: `오늘 오답과 비슷한(같은 레벨/모드) 문제가 부족해요.\nDB에 문제를 더 추가해 주세요.`,
              },
            ],
          };
        }

        const choices = (sim.choices ?? []) as string[];
        const header = `🧩 ${String(sim.mode).toUpperCase()} Lv.${Number(sim.level)}`;
        const text = `🔁 오답 복습(유사 문제)\n\n${header}\n${sim.prompt}\n\n${
          choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지 없음)"
        }\n\nq_id: \`${sim.q_id}\`\n\n정답은 **숫자(1~)** 또는 **A~E**로 보내 주세요.`;
        return { content: [{ type: "text", text }] };
      }

      // -------------------- 6) 시작/다음 => 문제 출제 --------------------
      if (/^(시작|다음|계속|문제|출제)$/i.test(message)) {
        // 난이도 안내는 최초 1회만
        const intro = difficultyPromptShown[user_id]
          ? ""
          : `정답은 숫자(1~) 또는 A~E로 보내 주세요.\n난이도는 한 번만 물어볼게요.\n현재 레벨이 쉬우면 "쉬워요", 어려우면 "어려워요"라고 말해주면 다음부터 조정할게요.\n\n`;

        difficultyPromptShown[user_id] = true;

        // signal이 들어오면 유저 레벨 조정(바로 반영)
        let newLevel = currentLevel;
        if (hasEasy) newLevel = Math.min(10, currentLevel + 1);
        if (hasHard) newLevel = Math.max(1, currentLevel - 1);

        if (newLevel !== currentLevel) {
          await supabase.from("users").update({ current_level: newLevel }).eq("user_id", user_id);
        }

        const q = await pickRandomQuestionForUser({ user_id, mode: lastMode, level: newLevel });

        if (!q) {
          const ex = await isLevelExhausted(user_id, lastMode, newLevel);
          if (ex.exhausted) {
            pending[user_id] = { type: "level_clear", mode: lastMode, level: newLevel };
            return {
              content: [
                {
                  type: "text",
                  text: `🎉 ${lastMode.toUpperCase()} Lv.${newLevel} 레벨을 클리어했어요!\n\n다음 레벨(Lv.${Math.min(
                    10,
                    newLevel + 1
                  )})로 넘어갈까요?\n- ㅇㅇ / ㄴㄴ`,
                },
              ],
            };
          }

          return { content: [{ type: "text", text: "문제가 부족해요. DB에 문제를 더 추가해 주세요." }], isError: true };
        }

        const choices = (q.choices ?? []) as string[];
        const header = `🧩 ${String(q.mode).toUpperCase()} Lv.${Number(q.level)}`;
        const text =
          intro +
          `${header}\n${q.prompt}\n\n${
            choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지 없음)"
          }\n\nq_id: \`${q.q_id}\`\n\n정답은 **숫자(1~)** 또는 **A~E**로 보내 주세요.`;

        return { content: [{ type: "text", text }] };
      }

      // -------------------- 7) 기본 응답(가이드) --------------------
      return {
        content: [
          {
            type: "text",
            text:
              `원하는 동작을 이렇게 말해보세요:\n` +
              `- "시작" / "다음"\n` +
              `- "쉬워요" / "어려워요"\n` +
              `- "요약" / "정리" (오늘 푼 문제+정답+해설)\n` +
              `- "오답노트" / "틀린문제" / "오답 복습"\n` +
              `- 모드 변경: "토익" / "문법" / "단어" / "여행" / "비즈니스"\n` +
              `- "그만" (자동 오늘 오답노트)`,
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