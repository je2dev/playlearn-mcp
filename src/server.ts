import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// ✅ MCP SDK (HTTP)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// -------- Zod --------
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
  payload: z.record(z.string(), z.any()), // zod v4 형식
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

// -------- Helpers --------
async function ensureUser(user_id: string) {
  const { data } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_id", user_id)
    .maybeSingle();

  if (data) return;

  const { error } = await supabase.from("users").insert({
    user_id,
    current_level: 3,
    last_mode: null,
  });
  if (error) throw error;
}

// -------- MCP Server --------
const server = new McpServer({ name: "playlearn-mcp", version: "1.0.0" });

// Tool: get_question
server.tool(
  "get_question",
  "모드/레벨에 맞는 활성(is_active=true) 객관식 문제 1개를 가져옵니다.",
  { mode: ModeEnum, level: z.number().int().min(1).max(10) },
  async (args) => {
    const { mode, level } = GetQuestionArgs.parse(args);

    // ✅ service 컬럼이 있는 스키마니까, 필요하면 서비스명으로도 필터
    const { data, error } = await supabase
      .from("questions")
      .select("q_id, mode, level, prompt, choices, answer, explanation, media")
      .eq("mode", mode)
      .eq("level", level)
      .eq("is_active", true)
      // .eq("service", "playlearn-core") // 필요하면 주석 해제
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    if (!data || data.length === 0) {
      return { content: [{ type: "text", text: "해당 모드/레벨에 활성화된 문제가 없습니다." }] };
    }

    const q = data[0];
    const choices = (q.choices ?? []) as string[];

    const mediaMd =
      q.media?.image ? `\n\n![image](${q.media.image})\n` : "";

    const text =
`🧩 **문제 (${q.mode} / Lv.${q.level})**
${q.prompt}${mediaMd}

${choices.length ? choices.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(선택지가 없습니다)"}

q_id: \`${q.q_id}\``;

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
    const { user_id, q_id, user_answer, signal } = SubmitAnswerArgs.parse(args);
    await ensureUser(user_id);

    const { data: q, error: qErr } = await supabase
      .from("questions")
      .select("q_id, mode, level, answer, explanation")
      .eq("q_id", q_id)
      .maybeSingle();

    if (qErr) throw qErr;
    if (!q) {
      return { content: [{ type: "text", text: "해당 q_id 문제를 찾지 못했습니다." }] };
    }

    const isCorrect = user_answer.trim() === String(q.answer).trim();

    const { error: logErr } = await supabase.from("study_logs").insert({
      user_id,
      event_type: "quiz_attempt",
      ref_id: String(q.q_id),
      mode: q.mode,
      level: q.level,
      is_correct: isCorrect,
      signal: signal ?? "neutral",
    });
    if (logErr) throw logErr;

    const text =
`${isCorrect ? "✅ 정답" : "❌ 오답"}

- 정답: **${q.answer}**
- 해설: ${q.explanation}
- 신호: ${signal ?? "neutral"}`;

    return { content: [{ type: "text", text }] };
  }
);

// Tool: save_item  (review_items 테이블 사용)
server.tool(
  "save_item",
  "단어/오답/메모를 review_items에 저장합니다.",
  {
    user_id: z.string(),
    item_type: z.enum(["vocab", "mistake", "note"]),
    key: z.string(),
    payload: z.record(z.string(), z.any()),
  },
  async (args) => {
    const { user_id, item_type, key, payload } = SaveItemArgs.parse(args);
    await ensureUser(user_id);

    const { error } = await supabase.from("review_items").insert({
      item_id: randomUUID(),      // 네 review_items가 uuid PK라서 서버가 생성
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

    const { data, error } = await query
      .order("last_seen_at", { ascending: true })
      .limit(parsed.limit);

    if (error) throw error;

    const text =
`📌 복습 아이템 (${data?.length ?? 0}개)` +
(data && data.length
  ? "\n" + data.map((it, idx) =>
      `${idx + 1}) [${it.item_type}] **${it.key}**\n- payload: ${JSON.stringify(it.payload)}`
    ).join("\n")
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
    const wrong = (attempts ?? []).filter((x) => x.is_correct === false).length;

    const { data: saved, error: sErr } = await supabase
      .from("review_items")
      .select("item_type, created_at")
      .eq("user_id", user_id)
      .gte("created_at", since);

    if (sErr) throw sErr;

    const savedTotal = saved?.length ?? 0;
    const savedVocab = (saved ?? []).filter((x) => x.item_type === "vocab").length;

    const text =
`📊 최근 ${days}일 요약
- 퀴즈 시도: ${total}회
- 오답: ${wrong}개
- 저장 아이템: ${savedTotal}개 (단어 ${savedVocab}개)`;

    return { content: [{ type: "text", text }] };
  }
);

// -------- HTTP Endpoint (PlayMCP가 물리는 부분) --------
const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = (req.headers["mcp-session-id"] as string) || "";

  let transport = transports[sessionId];
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);

    // 새 세션 id를 저장(내부 필드라 any로 접근)
    const newSessionId = (transport as any)._sessionId as string | undefined;
    if (newSessionId) transports[newSessionId] = transport;
  }

  // ✅ POST는 body를 3번째 인자로 전달
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = (req.headers["mcp-session-id"] as string) || "";
  const transport = transports[sessionId];

  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // ✅ GET은 (req,res)만
  await transport.handleRequest(req, res);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ MCP HTTP Server running: http://localhost:${PORT}/mcp`);
});