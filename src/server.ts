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
  user_id: z.string().min(1).optional(), // ✅ optional
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

const SaveItemArgs = z.object({
  user_id: z.string().min(1).optional(), // ✅ optional
  item_type: z.enum(["vocab", "mistake", "note"]),
  key: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
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

/* -------------------------------- Helpers -------------------------------- */

// ✅ user_id가 없으면 공통 ID로 대체 (카카오 데모용)
function resolveUserId(raw: unknown): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return "kakao_default";
}

async function ensureUser(user_id: string, mode?: Mode) {
  const { data, error } = await supabase.from("users").select("user_id").eq("user_id", user_id).maybeSingle();
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
    userPickIndex !== null && choices[userPickIndex] != null ? String(choices[userPickIndex]).trim() : raw;

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
  const isCorrect = userPickValue.trim().toUpperCase() === ansUpper || raw.trim().toUpperCase() === ansUpper;

  return { isCorrect, raw, userPickIndex, userPickValue, ansStr };
}

// 랜덤 문제 뽑기 (같은 mode/level에서 랜덤)
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

/* --------------------------- Tool: placement_submit -------------------------- */
server.tool(
  "placement_submit",
  "진단 답안을 채점하고 다음 문제 또는 최종 레벨 결과를 반환합니다. (총 5문제)",
  {
    user_id: z.string().min(1).optional(), // ✅ 카카오가 안 보내도 됨
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

      // 1) 문제 조회 (먼저)
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

      // 2) 세션 조회 (없으면 여기서 새로 생성 → 카카오가 placement_start 안 써도 동작)
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
      if (graded.isCorrect) {
        level = Math.min(10, level + 1);
      } else if (signal === "hard") {
        level = Math.max(1, level - 1);
      }

      const done = asked >= PLACEMENT_QUESTION_COUNT;

      // 4) 로그 저장 (q_id/ event_type / ref_id 다 채움 → NOT NULL 방지)
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

이제 이 레벨을 기준으로 토익 문제를 내 드릴게요.
"계속"이라고 보내면 바로 다음 문제부터 풀 수 있어요.`;
        return { content: [{ type: "text", text }] };
      }

      // 7) 다음 문제 (랜덤)
      const nextQ = await pickRandomQuestion(mode, level);
      if (!nextQ) {
        return {
          content: [
            {
              type: "text",
              text: "다음 문제를 찾지 못했습니다. (questions 테이블에 is_active=true 문제를 더 추가해 주세요)",
            },
          ],
          isError: true,
        };
      }

      const nChoices = (nextQ.choices ?? []) as string[];
      const mediaMd = nextQ.media?.image ? `\n\n![image](${nextQ.media.image})\n` : "";

      const feedback = `${graded.isCorrect ? "✅ 정답이에요!" : "❌ 아쉽지만 오답이에요."}
- 내가 보낸 답: ${graded.raw}
- 정답(저장값): ${graded.ansStr}
- 해설: ${Q.explanation ?? "(해설 없음)"} 

현재 임시 레벨: Lv.${level}
`;

      const nextText = `🧩 다음 문제 (${nextQ.mode} / Lv.${nextQ.level})
${nextQ.prompt}${mediaMd}

${
  nChoices.length ? nChoices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"
}

q_id: \`${nextQ.q_id}\`

정답은 **1번** 또는 **A**처럼 숫자 하나 또는 알파벳 하나로 보내 주세요.`;

      return { content: [{ type: "text", text: `${feedback}\n\n${nextText}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_submit 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------ Tool: get_question ------------------------------ */
server.tool(
  "get_question",
  "모드/레벨에 맞는 활성(is_active=true) 객관식 문제 1개를 가져옵니다.",
  { mode: ModeEnum, level: z.number().int().min(1).max(10) },
  async (args) => {
    const { mode, level } = GetQuestionArgs.parse(args);

    const { data, error } = await supabase
      .from("questions")
      .select("q_id, mode, level, prompt, choices, answer, explanation, media")
      .eq("mode", mode)
      .eq("level", level)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    if (!data || data.length === 0) {
      return { content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다." }] };
    }

    const q = data[0] as any;
    const choices = (q.choices ?? []) as string[];
    const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

    const text = `🧩 **문제 (${q.mode} / Lv.${q.level})**
${q.prompt}${mediaMd}

${
  choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"
}

q_id: \`${q.q_id}\`

정답은 **1번** 또는 **A**처럼 숫자 하나 또는 알파벳 하나로 보내 주세요.`;

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: submit_answer ------------------------------- */
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장",
  {
    user_id: z.string().optional(), // ✅ optional
    q_id: z.string().uuid(),
    user_answer: z.string(),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const parsed = SubmitAnswerArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const { q_id, user_answer, signal } = parsed;

      await ensureUser(user_id, "toeic"); // 기본 모드 toeic

      // 문제 조회
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices")
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

      const dbgPicked =
        graded.userPickIndex != null
          ? `${graded.userPickIndex + 1}번${choices[graded.userPickIndex] ? ` (${choices[graded.userPickIndex]})` : ""}`
          : graded.raw;

      const text = `${graded.isCorrect ? "✅ 정답입니다!" : "❌ 아쉽지만 오답입니다."}

- 내가 보낸 답: ${String(user_answer).trim()}
- 해석된 선택: ${dbgPicked}
- 정답(저장값): ${ansRaw}
- 해설: ${QQ.explanation ?? "(해설 없음)"}

문제가 너무 쉽거나 너무 어렵게 느껴지면,
채팅으로 "쉬워요" 또는 "어려워요"라고 편하게 말씀해 주세요.
다음 문제 난이도를 조정할 때 참고하겠습니다.`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(err)}` }], isError: true };
    }
  }
);

/* ------------------------------- Tool: save_item ------------------------------- */
server.tool(
  "save_item",
  "단어/오답/메모를 review_items에 저장합니다.",
  {
    user_id: z.string().optional(),
    item_type: z.enum(["vocab", "mistake", "note"]),
    key: z.string(),
    payload: z.record(z.string(), z.unknown()),
  },
  async (args) => {
    const parsed = SaveItemArgs.parse(args);
    const user_id = resolveUserId(parsed.user_id);
    const { item_type, key, payload } = parsed;

    // 단어는 toeic, 나머지는 grammar 정도로 태깅
    const defaultMode: Mode = item_type === "vocab" ? "toeic" : "grammar";
    await ensureUser(user_id, defaultMode);

    const { error } = await supabase.from("review_items").insert({
      item_id: randomUUID(),
      user_id,
      item_type,
      key,
      payload,
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

    let query = supabase.from("review_items").select("item_id, item_type, key, payload, strength, last_seen_at, created_at").eq("user_id", user_id);

    if (parsed.item_type) query = query.eq("item_type", parsed.item_type);

    const { data, error } = await query.order("last_seen_at", { ascending: true }).limit(parsed.limit);

    if (error) throw error;

    const text =
      `📌 복습 아이템 (${data?.length ?? 0}개)` +
      (data && data.length
        ? "\n" +
          data
            .map((it: any, idx: number) => `${idx + 1}) [${it.item_type}] **${it.key}**\n- payload: ${JSON.stringify(it.payload)}`)
            .join("\n")
        : "\n(없음)");

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: get_learning_summary ------------------------------- */
server.tool(
  "get_learning_summary",
  "기간(최근 N일) 기반 학습 요약을 제공합니다.",
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

/* =========================
   ADD: Kakao chat router tool (FINAL)
   - handle_user_message
   - fixes:
     1) choices show as "1. A. ..."
     2) after answer => always grade first, then wait for "ㅇㅇ/ㄱㄱ/다음"
   ========================= */

function normalizeMsg(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function parseModeIntent(msg: string): Mode | null {
  if (msg.includes("토익") || msg.includes("toeic")) return "toeic";
  if (msg.includes("문법") || msg.includes("grammar")) return "grammar";
  if (msg.includes("여행") || msg.includes("travel")) return "travel";
  if (msg.includes("비즈") || msg.includes("business")) return "business";
  if (msg.includes("단어") || msg.includes("vocab")) return "vocab";
  return null;
}

function parseChoiceAnswer(msg: string): string | null {
  const m = normalizeMsg(msg);
  if (!m) return null;
  if (/^\d+$/.test(m)) return m;
  const up = m.toUpperCase();
  if (/^[A-E]$/.test(up)) return up;
  return null;
}

function isNextIntent(msg: string): boolean {
  const m = normalizeMsg(msg);
  const set = new Set(["다음", "넘어가", "계속", "진행", "next", "go", "yes", "y", "ok", "ㅇㅇ", "ㅇ", "응", "ㅇㅋ", "오케", "오키", "ㄱㄱ", "ㄱ"]);
  if (set.has(m)) return true;
  const tokens = m.split(" ");
  return tokens.some((t) => set.has(t));
}

function isStopIntent(msg: string): boolean {
  const m = normalizeMsg(msg);
  return m.includes("그만") || m.includes("종료") || m.includes("멈춰") || m.includes("stop") || m.includes("끝");
}

function parseDifficultySignal(msg: string): "easy" | "hard" | null {
  const m = normalizeMsg(msg);
  if (m.includes("쉬워")) return "easy";
  if (m.includes("어려")) return "hard";
  return null;
}

function formatChoicesWithNumberAndAlpha(choices: string[]): string {
  const alpha = ["A", "B", "C", "D", "E", "F"];
  if (!choices?.length) return "(선택지가 없습니다)";
  return choices.map((c, i) => `${i + 1}. ${alpha[i] ? alpha[i] + "." : ""} ${c}`).join("\n");
}

function formatQuestionText(q: any): string {
  const choices = (q.choices ?? []) as string[];
  const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";
  return `🧩 문제 (${q.mode} / Lv.${q.level})
${q.prompt}${mediaMd}

${formatChoicesWithNumberAndAlpha(choices)}

q_id: \`${q.q_id}\`

정답은 **1번** 또는 **A**처럼 숫자 하나 또는 알파벳 하나로 보내 주세요.`;
}

type PracticeSession = {
  user_id: string;
  mode: Mode;
  level: number;
  last_q_id: string | null;
  awaiting_next: boolean; // 답 채점 후 "다음" 기다림
  asked_count: number;
  correct_count: number;
  updated_at: number;
};

const practiceSessions = new Map<string, PracticeSession>();
const PRACTICE_TTL_MS = 1000 * 60 * 60; // 1h

function getPractice(user_id: string): PracticeSession | null {
  const s = practiceSessions.get(user_id);
  if (!s) return null;
  if (Date.now() - s.updated_at > PRACTICE_TTL_MS) {
    practiceSessions.delete(user_id);
    return null;
  }
  return s;
}

function setPractice(s: PracticeSession) {
  s.updated_at = Date.now();
  practiceSessions.set(s.user_id, s);
}

const HandleUserMessageArgs = z.object({
  user_id: z.string().min(1).optional(),
  message: z.string().min(1),
});

server.tool(
  "handle_user_message",
  "카카오 채팅 입력을 받아 (시작/답/다음/난이도/종료) 의도를 처리하고 학습 흐름을 진행합니다.",
  { user_id: z.string().min(1).optional(), message: z.string().min(1) },
  async (args) => {
    try {
      const parsed = HandleUserMessageArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const msg = normalizeMsg(parsed.message);

      const modeIntent = parseModeIntent(msg);
      await ensureUser(user_id, modeIntent ?? "toeic");

      // 유저 상태 로드
      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("user_id, current_level, placement_done, last_mode")
        .eq("user_id", user_id)
        .maybeSingle();
      if (uErr) throw uErr;

      const currentLevel = Number((u as any)?.current_level ?? 3);
      const lastMode: Mode = ((u as any)?.last_mode ?? "toeic") as Mode;

      // 종료
      if (isStopIntent(msg)) {
        const s0 = getPractice(user_id);
        if (!s0) {
          return { content: [{ type: "text", text: "오케이. 오늘은 여기까지! 다음에 ‘토익공부’처럼 말하면 다시 시작할게." }] };
        }
        const acc = s0.asked_count ? Math.round((s0.correct_count / s0.asked_count) * 100) : 0;
        practiceSessions.delete(user_id);
        return {
          content: [
            {
              type: "text",
              text: `✅ 오늘 학습 요약
- 모드: ${s0.mode}
- 레벨: Lv.${s0.level}
- 푼 문제: ${s0.asked_count}
- 정답: ${s0.correct_count}
- 정답률: ${acc}%`,
            },
          ],
        };
      }

      // 세션 없으면 시작
      let s = getPractice(user_id);
      if (!s) {
        const modeToUse = modeIntent ?? lastMode ?? "toeic";
        const levelToUse = currentLevel;

        const q = await pickRandomQuestion(modeToUse, levelToUse);
        if (!q) {
          return {
            content: [{ type: "text", text: "문제가 부족해요. questions 테이블에 is_active=true 문제를 더 넣어야 해요." }],
            isError: true,
          };
        }

        s = {
          user_id,
          mode: modeToUse,
          level: levelToUse,
          last_q_id: q.q_id,
          awaiting_next: false,
          asked_count: 0,
          correct_count: 0,
          updated_at: Date.now(),
        };
        setPractice(s);

        return {
          content: [
            {
              type: "text",
              text: `좋아. **${modeToUse.toUpperCase()} Lv.${levelToUse}**로 시작하자.\n(끝낼 땐 “그만”)\n\n${formatQuestionText(q)}`,
            },
          ],
        };
      }

      // 난이도 조정
      const diff = parseDifficultySignal(msg);
      if (diff) {
        if (diff === "easy") s.level = Math.min(10, s.level + 1);
        if (diff === "hard") s.level = Math.max(1, s.level - 1);
        setPractice(s);
        return {
          content: [
            { type: "text", text: `오케이. 다음 문제부터 난이도 조정할게 → **Lv.${s.level}**\n(다음 문제는 “ㅇㅇ/ㄱㄱ/다음”)` },
          ],
        };
      }

      // 답 처리: 답이면 무조건 채점부터
      const answer = parseChoiceAnswer(msg);
      if (answer) {
        const qid = s.last_q_id;
        if (!qid) {
          return { content: [{ type: "text", text: "현재 문제 상태가 꼬였어. ‘토익공부’라고 다시 시작해줘." }], isError: true };
        }

        const { data: q, error: qErr } = await supabase
          .from("questions")
          .select("q_id, mode, level, answer, explanation, choices, prompt, media")
          .eq("q_id", qid)
          .maybeSingle();
        if (qErr) throw qErr;
        if (!q) {
          return { content: [{ type: "text", text: "문제를 찾지 못했어. ‘토익공부’라고 다시 시작해줘." }], isError: true };
        }

        const QQ = q as any;
        const choices = (QQ.choices ?? []) as string[];
        const graded = gradeAnswer({ choices, correctAnswer: QQ.answer, userAnswer: answer });

        // 로그 저장
        const { error: logErr } = await supabase.from("study_logs").insert({
          user_id,
          q_id: QQ.q_id,
          event_type: "quiz_attempt",
          ref_id: String(QQ.q_id),
          mode: QQ.mode,
          level: QQ.level,
          is_correct: graded.isCorrect,
          user_answer: graded.userPickValue ?? graded.raw ?? answer,
          signal: "neutral",
        });
        if (logErr) throw logErr;

        s.asked_count += 1;
        if (graded.isCorrect) s.correct_count += 1;

        s.awaiting_next = true;
        setPractice(s);

        const ansRaw = String(QQ.answer ?? "").trim();
        const feedback = `${graded.isCorrect ? "✅ 정답입니다!" : "❌ 아쉽지만 오답입니다."}

- 내 답: ${answer}
- 정답: ${ansRaw}
- 해설: ${QQ.explanation ?? "(해설 없음)"}

다음 문제 갈까? (ㅇㅇ / ㄱㄱ / 다음)`;

        return { content: [{ type: "text", text: feedback }] };
      }

      // 다음 문제
      if (isNextIntent(msg)) {
        if (!s.awaiting_next) {
          return { content: [{ type: "text", text: "지금은 답을 먼저 보내야 해 🙂 (예: 1 또는 A)" }] };
        }

        const q = await pickRandomQuestion(s.mode, s.level);
        if (!q) {
          return { content: [{ type: "text", text: "다음 문제가 부족해요. questions 테이블에 문제를 더 넣어야 해요." }], isError: true };
        }

        s.last_q_id = q.q_id;
        s.awaiting_next = false;
        setPractice(s);

        return { content: [{ type: "text", text: formatQuestionText(q) }] };
      }

      // 그 외 안내
      return {
        content: [
          {
            type: "text",
            text: `답은 **1** 또는 **A**처럼 하나만 보내면 돼.\n채점 후엔 “ㅇㅇ/ㄱㄱ/다음”이라고 보내면 다음 문제로 넘어가 🙂\n끝낼 땐 “그만”`,
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