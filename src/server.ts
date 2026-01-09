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

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) userPickIndex = n - 1;
  }

  if (upper in alphaMap) userPickIndex = alphaMap[upper];

  const userPickValue =
    userPickIndex !== null && choices[userPickIndex] != null
      ? String(choices[userPickIndex]).trim()
      : raw;

  const ansStr = String(opts.correctAnswer ?? "").trim();
  const ansUpper = ansStr.toUpperCase();

  if (/^\d+$/.test(ansStr) && userPickIndex !== null) {
    const ansIndex = Number(ansStr) - 1;
    return { isCorrect: ansIndex === userPickIndex, raw, userPickIndex, userPickValue, ansStr };
  }

  if (ansStr.length === 1 && ansUpper in alphaMap && userPickIndex !== null) {
    return { isCorrect: alphaMap[ansUpper] === userPickIndex, raw, userPickIndex, userPickValue, ansStr };
  }

  const isCorrect =
    userPickValue.trim().toUpperCase() === ansUpper ||
    raw.trim().toUpperCase() === ansUpper;

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

/* --------------------------- MCP: placement_start --------------------------- */
server.tool(
  "placement_start",
  "진단(간이 배치) 세션을 시작하고 첫 문제를 반환합니다.",
  { user_id: z.string().min(1).optional(), mode: ModeEnum },
  async (args) => {
    try {
      const parsed = PlacementStartArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const mode = parsed.mode;

      await ensureUser(user_id, mode);

      const { data: u, error: uErr } = await supabase
        .from("users")
        .select("current_level")
        .eq("user_id", user_id)
        .maybeSingle();

      if (uErr) throw uErr;

      const startLevel = Number((u as any)?.current_level ?? 3);
      const placement_id = randomUUID();

      const { error: sErr } = await supabase.from("placement_sessions").insert({
        placement_id,
        user_id,
        mode,
        asked_count: 0,
        correct_count: 0,
        current_level: startLevel,
        is_done: false,
        last_q_id: null,
      });
      if (sErr) throw sErr;

      const q = await pickRandomQuestion(mode, startLevel);

      if (!q) {
        return {
          content: [
            {
              type: "text",
              text:
                `진단 시작은 했지만, mode=${mode}, level=${startLevel}에 활성 문제가 없습니다.\n` +
                `(questions 테이블에 is_active=true 데이터를 추가해 주세요)\n` +
                `placement_id: ${placement_id}`,
            },
          ],
          isError: true,
        };
      }

      const choices = (q.choices ?? []) as string[];
      const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

      const { error: upErr } = await supabase
        .from("placement_sessions")
        .update({
          asked_count: 1,
          last_q_id: q.q_id,
        })
        .eq("placement_id", placement_id);

      if (upErr) throw upErr;

      const text =
`🧪 진단을 시작합니다. (총 ${PLACEMENT_QUESTION_COUNT}문제)
- 시작 레벨: Lv.${startLevel}
- placement_id: \`${placement_id}\`

🧩 **문제 (${q.mode} / Lv.${q.level})**
${q.prompt}${mediaMd}

${choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${q.q_id}\`

답은 "1~5" 또는 "A~E"로 보내도 됩니다.
그리고 난이도 체감도 알려주세요: hard / easy / neutral`;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_start 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* -------------------------- MCP: placement_submit -------------------------- */
server.tool(
  "placement_submit",
  "진단 세션에서 답안을 채점하고 다음 문제를 반환하거나 최종 레벨을 확정합니다.",
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
      const placement_id = parsed.placement_id;
      const q_id = parsed.q_id;
      const user_answer = parsed.user_answer.trim();
      const signal = parsed.signal ?? "neutral";

      // 세션 확인
      const { data: sess, error: sErr } = await supabase
        .from("placement_sessions")
        .select("placement_id, user_id, mode, is_done, asked_count, correct_count, current_level")
        .eq("placement_id", placement_id)
        .maybeSingle();

      if (sErr) throw sErr;
      if (!sess) {
        return { content: [{ type: "text", text: "placement_id 세션을 찾지 못했습니다." }], isError: true };
      }

      const S = sess as any;

      if (S.user_id !== user_id) {
        return { content: [{ type: "text", text: "이 placement_id는 해당 user_id의 세션이 아닙니다." }], isError: true };
      }
      if (S.is_done) {
        return { content: [{ type: "text", text: "이미 종료된 진단 세션입니다." }], isError: true };
      }

      // 문제 가져오기
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, prompt, choices, answer, explanation, media")
        .eq("q_id", q_id)
        .maybeSingle();

      if (qErr) throw qErr;
      if (!q) {
        return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }], isError: true };
      }

      const Q = q as any;
      const choices = (Q.choices ?? []) as string[];

      const graded = gradeAnswer({
        choices,
        correctAnswer: Q.answer,
        userAnswer: user_answer,
      });

      // 로그 저장
      const { error: logErr } = await supabase.from("study_logs").insert({
        user_id,
        event_type: "placement_attempt",
        ref_id: String(Q.q_id),
        mode: S.mode,
        level: Q.level,
        is_correct: graded.isCorrect,
        signal,
      });
      if (logErr) throw logErr;

      const nextAsked = Number(S.asked_count ?? 0) + 1;
      const nextCorrect = Number(S.correct_count ?? 0) + (graded.isCorrect ? 1 : 0);

      let nextLevel = Number(S.current_level ?? 3);
      if (graded.isCorrect) {
        nextLevel = Math.min(10, nextLevel + 1);
      }

      const isFinish = nextAsked >= PLACEMENT_QUESTION_COUNT;

      if (isFinish) {
        const finalLevel = nextLevel;

        const { error: finErr } = await supabase
          .from("placement_sessions")
          .update({
            is_done: true,
            finished_at: new Date().toISOString(),
            asked_count: nextAsked,
            correct_count: nextCorrect,
            current_level: finalLevel,
            last_q_id: Q.q_id,
          })
          .eq("placement_id", placement_id);

        if (finErr) throw finErr;

        const { error: uUpErr } = await supabase
          .from("users")
          .update({
            current_level: finalLevel,
            placement_done: true,
            last_mode: S.mode,
          })
          .eq("user_id", user_id);

        if (uUpErr) throw uUpErr;

        const summary =
`✅ 진단 완료!
- 최종 레벨: **Lv.${finalLevel}**
- 맞춘 개수: ${nextCorrect} / ${PLACEMENT_QUESTION_COUNT}`;

        return { content: [{ type: "text", text: summary }] };
      }

      // 다음 문제 뽑기
      const nextQ = await pickRandomQuestion(S.mode as Mode, nextLevel);

      if (!nextQ) {
        const finalLevel = nextLevel;

        await supabase
          .from("placement_sessions")
          .update({
            is_done: true,
            finished_at: new Date().toISOString(),
            asked_count: nextAsked,
            correct_count: nextCorrect,
            current_level: finalLevel,
            last_q_id: Q.q_id,
          })
          .eq("placement_id", placement_id);

        await supabase
          .from("users")
          .update({
            current_level: finalLevel,
            placement_done: true,
            last_mode: S.mode,
          })
          .eq("user_id", user_id);

        const fallback =
`진단은 진행됐지만 다음 문제를 찾지 못해 종료합니다.
- 최종 레벨: Lv.${finalLevel}
(questions 테이블에 is_active=true 문제를 더 추가해 주세요)`;

        return { content: [{ type: "text", text: fallback }] };
      }

      const NQ = nextQ as any;
      const nChoices = (NQ.choices ?? []) as string[];
      const mediaMd = NQ.media?.image ? `\n\n![image](${NQ.media.image})\n` : "";

      const { error: upErr } = await supabase
        .from("placement_sessions")
        .update({
          asked_count: nextAsked,
          correct_count: nextCorrect,
          current_level: nextLevel,
          last_q_id: NQ.q_id,
        })
        .eq("placement_id", placement_id);

      if (upErr) throw upErr;

      const header =
`${graded.isCorrect ? "✅ 정답" : "❌ 오답"}
- 내가 보낸 답: ${graded.raw}
- 정답(저장값): ${graded.ansStr}
- 해설: ${Q.explanation ?? "(해설 없음)"}
- 난이도 신호: ${signal}

🧪 진단 진행 (${nextAsked} / ${PLACEMENT_QUESTION_COUNT})
- 현재 추정 레벨: Lv.${nextLevel}
- placement_id: \`${placement_id}\``;

      const nextText =
`🧩 **다음 문제 (${NQ.mode} / Lv.${NQ.level})**
${NQ.prompt}${mediaMd}

${nChoices.length ? nChoices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${NQ.q_id}\`

답은 "1~5" 또는 "A~E"로 보내도 됩니다.
난이도 체감도: hard / easy / neutral`;

      return { content: [{ type: "text", text: `${header}\n\n${nextText}` }] };
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
    const { mode, level } = GetQuestionArgs.parse(args);

    const q = await pickRandomQuestion(mode, level);
    if (!q) {
      return { content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다." }] };
    }

    const choices = (q.choices ?? []) as string[];
    const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

    const text =
`🧩 **문제 (${q.mode} / Lv.${q.level})**
${q.prompt}${mediaMd}

${choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${q.q_id}\`

답은 **1~4** 또는 **A/B/C/D**로 보내도 됩니다.`;

    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------- Tool: submit_answer ------------------------------- */
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장 + 사용자의 신호(hard/easy/neutral) 기록",
  {
    user_id: z.string().optional(),
    q_id: z.string(),
    user_answer: z.string(),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const parsed = SubmitAnswerArgs.parse(args);
      const user_id = resolveUserId(parsed.user_id);
      const q_id = parsed.q_id;
      const user_answer = parsed.user_answer;
      const signal = parsed.signal ?? "neutral";

      // 문제부터 가져오고 → 그 mode로 ensureUser
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices")
        .eq("q_id", q_id)
        .maybeSingle();

      if (qErr) throw qErr;
      if (!q) {
        return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }], isError: true };
      }

      const Q = q as any;
      await ensureUser(user_id, Q.mode as Mode);

      const choices = (Q.choices ?? []) as string[];

      const graded = gradeAnswer({
        choices,
        correctAnswer: Q.answer,
        userAnswer: user_answer,
      });

      const { error: logErr } = await supabase.from("study_logs").insert({
        user_id,
        event_type: "quiz_attempt",
        ref_id: String(Q.q_id),
        mode: Q.mode,
        level: Q.level,
        is_correct: graded.isCorrect,
        signal,
      });

      if (logErr) throw logErr;

      const dbgPicked =
        graded.userPickIndex !== null && choices[graded.userPickIndex]
          ? `${graded.userPickIndex + 1}번 (${choices[graded.userPickIndex]})`
          : graded.raw;

      const text =
`${graded.isCorrect ? "✅ 정답" : "❌ 오답"}

- 내가 보낸 답: ${String(user_answer).trim()}
- 해석된 선택: ${dbgPicked}
- 정답(저장값): ${graded.ansStr}
- 해설: ${Q.explanation ?? "(해설 없음)"}
- 신호: ${signal}`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(err)}` }],
        isError: true,
      };
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

    let query = supabase
      .from("review_items")
      .select("item_id, item_type, key, payload, strength, last_seen_at, created_at")
      .eq("user_id", user_id);

    if (parsed.item_type) query = query.eq("item_type", parsed.item_type);

    const { data, error } = await query
      .order("last_seen_at", { ascending: true })
      .limit(parsed.limit);

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

    const text =
`📊 최근 ${days}일 요약
- 퀴즈 시도: ${total}회
- 오답: ${wrong}개
- 저장 아이템: ${savedTotal}개 (단어 ${savedVocab}개)`;

    return { content: [{ type: "text", text }] };
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