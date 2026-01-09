// src/server.ts
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// ✅ MCP SDK (HTTP/SSE)
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
const SignalEnum = z.enum(["hard", "easy", "neutral"]).optional();

const GetQuestionArgs = z.object({
  mode: ModeEnum,
  level: z.number().int().min(1).max(10),
});

const SubmitAnswerArgs = z.object({
  user_id: z.string().min(1),
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

const SaveItemArgs = z.object({
  user_id: z.string().min(1),
  item_type: z.enum(["vocab", "mistake", "note"]),
  key: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

const GetReviewItemsArgs = z.object({
  user_id: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(5),
  item_type: z.enum(["vocab", "mistake", "note"]).optional(),
});

const GetLearningSummaryArgs = z.object({
  user_id: z.string().min(1),
  days: z.number().int().min(1).max(365).default(7),
});

// ✅ 추가: 진단(placement) 관련
const GetUserStateArgs = z.object({
  user_id: z.string().min(1),
});

const PlacementStartArgs = z.object({
  user_id: z.string().min(1),
  mode: ModeEnum,
});

const PlacementSubmitArgs = z.object({
  user_id: z.string().min(1),
  placement_id: z.string().uuid(),
  q_id: z.string().uuid(),
  user_answer: z.string().min(1),
  signal: SignalEnum,
});

/* -------------------------------- Helpers -------------------------------- */
async function ensureUser(user_id: string) {
  const { data, error } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error) throw error;
  if (data) return;

  const { error: insErr } = await supabase.from("users").insert({
    user_id,
    current_level: 3,
    exp_points: 0,
    placement_done: false,
    last_mode: null,
  });

  if (insErr) throw insErr;
}

// ✅ 추가: "1" / "A" 둘 다 인덱스로 정규화
function normalizeChoiceAnswer(input: string) {
  const raw = String(input ?? "").trim();
  const up = raw.toUpperCase();

  // 숫자면 1-index -> 0-index
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      return { kind: "index" as const, index: n - 1, raw };
    }
  }

  // 알파벳 A=0
  const code = up.charCodeAt(0);
  if (up.length === 1 && code >= 65 && code <= 73) {
    return { kind: "index" as const, index: code - 65, raw };
  }

  return { kind: "raw" as const, raw };
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
  // MCP Streamable HTTP는 클라이언트가 둘 다 accept 해야 함
  const accept = String(req.headers["accept"] ?? "");
  return accept.includes("text/event-stream") && accept.includes("application/json");
}

function safeJsonRpcError(res: Response, message = "Internal Server Error") {
  // MCP/JSON-RPC 스타일로 최소만 노출
  res.status(500).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/* ------------------------------- MCP Server ------------------------------- */
const server = new McpServer({ name: "playlearn-mcp", version: "1.0.0" });

/* ------------------------------ Tool: get_user_state ------------------------------ */
server.tool(
  "get_user_state",
  "유저 상태(레벨/진단완료 여부/마지막 모드)를 조회합니다.",
  { user_id: z.string().min(1) },
  async (args) => {
    try {
      const { user_id } = GetUserStateArgs.parse(args);

      const { data, error } = await supabase
        .from("users")
        .select("user_id, current_level, placement_done, last_mode")
        .eq("user_id", user_id)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                exists: false,
                placement_done: false,
                current_level: 3,
                last_mode: null,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              exists: true,
              placement_done: Boolean((data as any).placement_done ?? false),
              current_level: Number((data as any).current_level ?? 3),
              last_mode: (data as any).last_mode ?? null,
            }),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: safeErrorText(e) }], isError: true };
    }
  }
);

// Tool: get_question
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

    const text =
`🧩 **문제 (${q.mode} / Lv.${q.level})**
${q.prompt}${mediaMd}

${choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${q.q_id}\`

답은 **1~4** 또는 **A/B/C/D**로 보내도 됩니다.`;

    return { content: [{ type: "text", text }] };
  }
);

// Tool: submit_answer
server.tool(
  "submit_answer",
  "정답 체크 + study_logs 저장 + 사용자의 신호(hard/easy/neutral) 기록",
  {
    user_id: z.string(),
    q_id: z.string(),
    user_answer: z.string(),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const { user_id, q_id, user_answer, signal } = SubmitAnswerArgs.parse(args);
      await ensureUser(user_id);

      // ✅ choices까지 같이 가져와서 1/A 같은 입력도 처리 가능하게
      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices")
        .eq("q_id", q_id)
        .maybeSingle();

      if (qErr) throw qErr;
      if (!q) {
        return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }], isError: true };
      }

      const choices = (q as any).choices ? ((q as any).choices as string[]) : [];

      const uParsed = normalizeChoiceAnswer(user_answer);
      const ansRaw = String((q as any).answer ?? "").trim();
      const aParsed = normalizeChoiceAnswer(ansRaw);

      // user가 인덱스로 들어왔으면, 선택지 텍스트도 만들어둠
      const userPickValue =
        uParsed.kind === "index" && choices[uParsed.index] != null
          ? String(choices[uParsed.index]).trim()
          : uParsed.raw;

      let isCorrect = false;

      // 1) answer가 숫자/알파로 들어온 경우 -> index 비교
      if (uParsed.kind === "index" && aParsed.kind === "index") {
        isCorrect = uParsed.index === aParsed.index;
      }
      // 2) answer가 텍스트(선택지 문장)인 경우 -> 텍스트 비교
      else {
        isCorrect =
          userPickValue.trim().toUpperCase() === ansRaw.toUpperCase() ||
          uParsed.raw.trim().toUpperCase() === ansRaw.toUpperCase();
      }

      const { error: logErr } = await supabase.from("study_logs").insert({
        user_id,
        event_type: "quiz_attempt",
        ref_id: String((q as any).q_id),
        mode: (q as any).mode,
        level: (q as any).level,
        is_correct: isCorrect,
        signal: signal ?? "neutral",
      });

      if (logErr) throw logErr;

      const dbgPicked =
        uParsed.kind === "index"
          ? `${uParsed.index + 1}번${choices[uParsed.index] ? ` (${choices[uParsed.index]})` : ""}`
          : uParsed.raw;

      const text =
`${isCorrect ? "✅ 정답" : "❌ 오답"}

- 내가 보낸 답: ${String(user_answer).trim()}
- 해석된 선택: ${dbgPicked}
- 정답(저장값): ${ansRaw}
- 해설: ${(q as any).explanation ?? "(해설 없음)"}
- 신호: ${signal ?? "neutral"}`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `submit_answer 실패: ${safeErrorText(err)}` }],
        isError: true,
      };
    }
  }
);

// Tool: save_item
server.tool(
  "save_item",
  "단어/오답/메모를 review_items에 저장합니다.",
  {
    user_id: z.string(),
    item_type: z.enum(["vocab", "mistake", "note"]),
    key: z.string(),
    payload: z.record(z.string(), z.unknown()),
  },
  async (args) => {
    const { user_id, item_type, key, payload } = SaveItemArgs.parse(args);
    await ensureUser(user_id);

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

// Tool: get_review_items
server.tool(
  "get_review_items",
  "복습할 아이템(오래 안 본 것 우선)을 가져옵니다.",
  {
    user_id: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    item_type: z.enum(["vocab", "mistake", "note"]).optional(),
  },
  async (args) => {
    const parsed = GetReviewItemsArgs.parse(args);
    await ensureUser(parsed.user_id);

    let query = supabase
      .from("review_items")
      .select("item_id, item_type, key, payload, strength, last_seen_at, created_at")
      .eq("user_id", parsed.user_id);

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

// Tool: get_learning_summary
server.tool(
  "get_learning_summary",
  "기간(최근 N일) 기반 학습 요약을 제공합니다.",
  { user_id: z.string(), days: z.number().int().min(1).max(365).optional() },
  async (args) => {
    const { user_id, days } = GetLearningSummaryArgs.parse(args);
    await ensureUser(user_id);

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

/* --------------------------- Tool: placement_start -------------------------- */
server.tool(
  "placement_start",
  "짧은 진단(기본 5문제) 세션을 만들고 첫 문제를 반환합니다.",
  { user_id: z.string().min(1), mode: ModeEnum },
  async (args) => {
    try {
      const { user_id, mode } = PlacementStartArgs.parse(args);
      await ensureUser(user_id);

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
      });
      if (sErr) throw sErr;

      const { data: qs, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, prompt, choices, media")
        .eq("mode", mode)
        .eq("level", startLevel)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1);

      if (qErr) throw qErr;
      if (!qs || qs.length === 0) {
        return { content: [{ type: "text", text: "진단 시작 실패: 해당 레벨 문제 없음" }], isError: true };
      }

      const q = qs[0] as any;
      const choices = (q.choices ?? []) as string[];
      const mediaMd = q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

      await supabase
        .from("placement_sessions")
        .update({ last_q_id: q.q_id })
        .eq("placement_id", placement_id);

      const text =
`🧪 진단 시작 (placement_id: \`${placement_id}\`)
현재 레벨 추정: Lv.${startLevel}

🧩 문제 (${q.mode} / Lv.${q.level})
${q.prompt}${mediaMd}

${choices.length ? choices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${q.q_id}\`

답은 **1~4** 또는 **A/B/C/D**로 보내도 됩니다.`;

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
    user_id: z.string().min(1),
    placement_id: z.string().uuid(),
    q_id: z.string().uuid(),
    user_answer: z.string().min(1),
    signal: z.enum(["hard", "easy", "neutral"]).optional(),
  },
  async (args) => {
    try {
      const { user_id, placement_id, q_id, user_answer } = PlacementSubmitArgs.parse(args);
      await ensureUser(user_id);

      const { data: s, error: sErr } = await supabase
        .from("placement_sessions")
        .select("*")
        .eq("placement_id", placement_id)
        .maybeSingle();
      if (sErr) throw sErr;
      if (!s) return { content: [{ type: "text", text: "placement_id 세션 없음" }], isError: true };
      if ((s as any).is_done) return { content: [{ type: "text", text: "이미 완료된 진단입니다." }], isError: true };

      const { data: q, error: qErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, answer, explanation, choices, prompt, media")
        .eq("q_id", q_id)
        .maybeSingle();
      if (qErr) throw qErr;
      if (!q) return { content: [{ type: "text", text: "문제(q_id) 없음" }], isError: true };

      const choices = (q as any).choices ? ((q as any).choices as string[]) : [];

      const uParsed = normalizeChoiceAnswer(user_answer);
      const ansRaw = String((q as any).answer ?? "").trim();
      const aParsed = normalizeChoiceAnswer(ansRaw);

      const userPickValue =
        uParsed.kind === "index" && choices[uParsed.index] != null
          ? String(choices[uParsed.index]).trim()
          : uParsed.raw;

      let isCorrect = false;
      if (uParsed.kind === "index" && aParsed.kind === "index") {
        isCorrect = uParsed.index === aParsed.index;
      } else {
        isCorrect =
          userPickValue.trim().toUpperCase() === ansRaw.toUpperCase() ||
          uParsed.raw.trim().toUpperCase() === ansRaw.toUpperCase();
      }

      const asked = Number((s as any).asked_count ?? 0) + 1;
      const correct = Number((s as any).correct_count ?? 0) + (isCorrect ? 1 : 0);

      // 레벨 업데이트 규칙(간단 버전)
      let level = Number((s as any).current_level ?? 3);
      if (isCorrect) level = Math.min(10, level + 1);

      const done = asked >= 5;

      const { error: upErr } = await supabase
        .from("placement_sessions")
        .update({
          asked_count: asked,
          correct_count: correct,
          current_level: level,
          last_q_id: q_id,
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
            last_mode: (s as any).mode ?? (q as any).mode ?? null,
          })
          .eq("user_id", user_id);
        if (uUpErr) throw uUpErr;

        return {
          content: [
            {
              type: "text",
              text:
`✅ 진단 완료!
- 정답: ${correct}/5
- 최종 레벨: Lv.${level}

이제부터는 이 레벨 기준으로 문제를 드릴게요.`,
            },
          ],
        };
      }

      // 다음 문제(업데이트된 레벨 기준)
      const mode = (s as any).mode;
      const { data: nexts, error: nErr } = await supabase
        .from("questions")
        .select("q_id, mode, level, prompt, choices, media")
        .eq("mode", mode)
        .eq("level", level)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1);

      if (nErr) throw nErr;
      if (!nexts || nexts.length === 0) {
        return { content: [{ type: "text", text: "다음 문제를 찾지 못했습니다." }], isError: true };
      }

      const nq = nexts[0] as any;
      const nChoices = (nq.choices ?? []) as string[];
      const mediaMd = nq.media?.image ? `\n\n![image](${nq.media.image})\n` : "";

      const text =
`${isCorrect ? "✅ 정답" : "❌ 오답"}
(현재 레벨 추정 → Lv.${level})

🧩 다음 문제 (${nq.mode} / Lv.${nq.level})
${nq.prompt}${mediaMd}

${nChoices.length ? nChoices.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${nq.q_id}\`

답은 **1~4** 또는 **A/B/C/D**로 보내도 됩니다.`;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `placement_submit 실패: ${safeErrorText(e)}` }], isError: true };
    }
  }
);

/* ------------------------------- Express App ------------------------------ */
const app = express();

// JSON 파싱 (MCP POST body용)
app.use(express.json({ limit: "1mb" }));

// 단순 헬스체크 (Render에서 timeout 방지/확인용)
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/* -------------------------- Session / Transport Store --------------------- */
// 주의: Render Free는 인스턴스가 자주 sleep/재시작 → 메모리 세션은 사라질 수 있음(정상)
const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionsLastSeen: Record<string, number> = {};
const SESSION_TTL_MS = 1000 * 60 * 30; // 30분

// 5분마다 오래된 세션 정리
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
    // MCP는 Accept 헤더 필수
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

      // 클라이언트에게 세션 id 전달
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