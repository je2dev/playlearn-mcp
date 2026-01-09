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
  // 안전하게 가려면 z.unknown() 권장. (유연함 유지하려면 z.any()도 OK)
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
    last_mode: null,
  });

  if (insErr) throw insErr;
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

q_id: \`${q.q_id}\``;

    return { content: [{ type: "text", text }] };
  }
);

// Tool: submit_answer
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

      const choices = (q.choices ?? []) as string[];

      // ---- 답안 정규화: "1" / "A" 둘 다 허용 ----
      const raw = String(user_answer).trim();
      const upper = raw.toUpperCase();

      let userPickIndex: number | null = null;

      // 숫자 "1" -> index 0
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 1) userPickIndex = n - 1;
      }

      // 알파 "A" -> index 0
      const alpha = { A: 0, B: 1, C: 2, D: 3, E: 4 } as const;
      if (upper in alpha) userPickIndex = alpha[upper as keyof typeof alpha];

      // userPickValue: choices가 있으면 실제 선택지 텍스트로, 아니면 raw
      const userPickValue =
        userPickIndex !== null && choices[userPickIndex] != null
          ? String(choices[userPickIndex]).trim()
          : raw;

      // answer가 숫자(인덱스/번호)인지 텍스트인지 둘 다 대응
      const ansRaw = q.answer;
      const ansStr = String(ansRaw).trim();

      // 1) answer가 "1" 같은 번호로 저장된 경우
      let isCorrect = false;
      if (/^\d+$/.test(ansStr) && userPickIndex !== null) {
        // answer가 "1"이면 index 0과 매칭
        const ansIndex = Number(ansStr) - 1;
        isCorrect = ansIndex === userPickIndex;
      } else {
        // 2) answer가 텍스트(예: "A" 또는 선택지 문장)인 경우
        // - answer가 "A"면 알파 인덱스로 비교도 한 번 더
        if (ansStr.length === 1 && ansStr.toUpperCase() in alpha && userPickIndex !== null) {
          isCorrect = alpha[ansStr.toUpperCase() as keyof typeof alpha] === userPickIndex;
        } else {
          // - 마지막은 텍스트 비교
          isCorrect = userPickValue === ansStr || raw === ansStr;
        }
      }

      // ✅ 로그 저장 (여기서 컬럼명이 다르면 바로 에러 메시지로 드러남)
      const { error: logErr } = await supabase.from("study_logs").insert({
        user_id,
        event_type: "quiz_attempt",
        ref_id: String(q.q_id),
        mode: q.mode,
        level: q.level,
        is_correct: isCorrect,
        signal: signal ?? "neutral",
        // 선택: 디버깅용으로 남기고 싶으면 컬럼 있을 때만
        // user_answer: raw,
      });

      if (logErr) throw logErr;

      const text =
`${isCorrect ? "✅ 정답" : "❌ 오답"}

- 내가 보낸 답: ${raw}
- 해석된 선택: ${userPickIndex !== null ? `${userPickIndex + 1}번` : "(해석불가)"} ${choices[userPickIndex ?? -1] ? `(${choices[userPickIndex ?? -1]})` : ""}
- 정답(저장값): ${ansStr}
- 해설: ${q.explanation ?? "(해설 없음)"}
- 신호: ${signal ?? "neutral"}`;

      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      // ✅ 여기 때문에 앞으로 [object Object] 안 뜨고 진짜 원인이 보임
      const msg =
        err?.message
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err, null, 2);

      return {
        content: [{ type: "text", text: `submit_answer 실패: ${msg}` }],
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