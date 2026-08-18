import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Send, Sparkles, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { getActiveSiteId } from "@/lib/site-context";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

interface TrendPoint {
  date: string;
  clicks: number;
  impressions: number;
}

interface TrendData {
  target: string;
  targetType: "page" | "query";
  granularity: "daily" | "weekly";
  points: TrendPoint[];
}

interface Msg {
  role: "user" | "assistant" | "tool_use";
  content: string;
  /** Human-readable label for tool_use messages (e.g. "/pricing" or '"wellows seo"') */
  toolLabel?: string;
  /** Tool name for tool_use messages */
  toolName?: string;
  /** Trend data attached when a get_trend_data tool result was received for this assistant turn */
  trendData?: TrendData;
}

const STREAM_URL = `${import.meta.env.BASE_URL}api/gsc/chat/stream`.replace(/\/+api/, "/api");

const SUGGESTIONS = [
  "What changed versus the previous period?",
  "Which pages are my biggest winners and losers?",
  "How many organic sessions and conversions did GA4 record?",
  "How is Bing performing versus Google for this range?",
  "How much traffic are AI assistants sending us?",
  "What are my top non-branded queries?",
  "Which queries am I ranking on page 2 for?",
  "What should I fix this week?",
];

// Shown when a URL filter is active — page-scoped grounding kicks in.
const URL_SUGGESTIONS = [
  "Give me the full performance picture for this page",
  "How many internal links point to this page, and with what anchors?",
  "Is this page converting? Show GA4 sessions and key events",
  "How does this page do on Bing vs Google?",
];

const DEFAULT_USER_MESSAGE =
  "Give me a tight read on this date range — headline movement vs the previous period, top winners and losers, branded vs unbranded split, indexing or CWV issues, and one concrete action for this week.";

interface StreamArgs {
  messages: Msg[];
  startDate: string;
  endDate: string;
  url: string | null;
  includeDefault: boolean;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onToolUse: (name: string, label: string) => void;
  onToolResult: (name: string, data: unknown) => void;
}

async function streamChat(args: StreamArgs): Promise<void> {
  const siteId = getActiveSiteId();
  // Only send user/assistant messages to the API — tool_use messages are UI-only.
  const apiMessages = args.messages
    .filter((m): m is Msg & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .map(({ role, content }) => ({ role, content }));

  const res = await fetch(STREAM_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(siteId != null ? { "x-site-id": String(siteId) } : {}),
    },
    body: JSON.stringify({
      messages: apiMessages,
      startDate: args.startDate,
      endDate: args.endDate,
      url: args.url,
      includeDefault: args.includeDefault,
    }),
    signal: args.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError: string | null = null;

  const handleEvent = (rawEvent: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      // Lines starting with ":" are SSE comments (proxy padding / keep-alives).
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (eventName === "delta" && typeof obj["text"] === "string") {
      args.onDelta(obj["text"]);
    } else if (eventName === "tool_use") {
      const name = typeof obj["name"] === "string" ? obj["name"] : "";
      const label = typeof obj["label"] === "string" ? obj["label"] : "";
      args.onToolUse(name, label);
    } else if (eventName === "tool_result") {
      const name = typeof obj["name"] === "string" ? obj["name"] : "";
      args.onToolResult(name, obj["data"]);
    } else if (eventName === "error") {
      streamError = typeof obj["error"] === "string" ? obj["error"] : "stream error";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      handleEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }

  // Flush any trailing bytes and process a final event that wasn't \n\n-terminated.
  buffer += decoder.decode();
  if (buffer.trim().length > 0) handleEvent(buffer);

  if (streamError) throw new Error(streamError);
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

function toolUseDescription(name: string, label: string): string {
  if (name === "get_page_metrics") return `Fetching page data for ${label}`;
  if (name === "get_query_metrics") return `Fetching query data for ${label}`;
  return `Fetching ${label}`;
}

/** Format a date label for the sparkline x-axis. Weekly labels (YYYY-Www) are
 * displayed as-is; daily dates are shortened to M/D. */
function formatDateLabel(date: string): string {
  // Weekly bucket: "2024-W03"
  if (/^\d{4}-W\d{2}$/.test(date)) return date.slice(5); // "W03"
  // Daily: "2024-01-15" → "1/15"
  try {
    const [, m, d] = date.split("-");
    return `${parseInt(m!, 10)}/${parseInt(d!, 10)}`;
  } catch {
    return date;
  }
}

/** Compact number formatter for sparkline axis/tooltips */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function TrendSparkline({ data }: { data: TrendData }) {
  const { points, target, targetType, granularity } = data;
  if (points.length < 2) return null;

  // Downsample for display: show at most 30 ticks to keep x-axis readable.
  const MAX_DISPLAY = 30;
  let displayPoints = points;
  if (points.length > MAX_DISPLAY) {
    const step = Math.ceil(points.length / MAX_DISPLAY);
    displayPoints = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  }

  // Determine how many x-axis ticks to show (max 6 to avoid crowding).
  const tickCount = Math.min(6, displayPoints.length);
  const tickIndexes = new Set<number>();
  for (let i = 0; i < tickCount; i++) {
    tickIndexes.add(Math.round((i / (tickCount - 1)) * (displayPoints.length - 1)));
  }
  const ticks = displayPoints
    .map((p, i) => (tickIndexes.has(i) ? p.date : null))
    .filter(Boolean) as string[];

  const label = targetType === "page"
    ? (target.startsWith("/") ? target : (() => { try { return new URL(target).pathname; } catch { return target; } })())
    : `"${target}"`;

  return (
    <div className="mt-3 pt-3 border-t border-border/40">
      <p className="text-xs text-muted-foreground mb-2 inline-flex items-center gap-1">
        Clicks &amp; impressions — {label} ({granularity})
        <InfoTip>
          A quick trend for this {targetType === "page" ? "page" : "keyword"} the assistant looked up.
          Solid line = clicks (people who visited), dashed line = impressions (times it appeared in Google).
          {granularity === "weekly"
            ? " Grouped by week because the date range is long — each point is a full week."
            : " Grouped by day — each point is one day."}
        </InfoTip>
      </p>
      <ResponsiveContainer width="100%" height={110}>
        <LineChart data={displayPoints} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="date"
            ticks={ticks}
            tickFormatter={formatDateLabel}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="imp"
            orientation="right"
            tickFormatter={fmtNum}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <YAxis
            yAxisId="clk"
            orientation="left"
            tickFormatter={fmtNum}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip
            formatter={(value: number, name: string) => [fmtNum(value), name === "clicks" ? "Clicks" : "Impressions"]}
            labelFormatter={(l: string) => l}
            contentStyle={{ fontSize: 11, padding: "4px 8px" }}
          />
          <Legend
            iconType="circle"
            iconSize={6}
            wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
          />
          <Line
            yAxisId="clk"
            type="monotone"
            dataKey="clicks"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
            name="clicks"
          />
          <Line
            yAxisId="imp"
            type="monotone"
            dataKey="impressions"
            stroke="hsl(var(--primary) / 0.4)"
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="3 3"
            name="impressions"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AskBody() {
  const { range } = useGscRange();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoRanFor = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const rangeKey = `${range.startDate}|${range.endDate}|${range.urlFilter ?? ""}`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  const send = (msgs: Msg[], includeDefault: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPending(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    streamChat({
      messages: msgs,
      startDate: range.startDate,
      endDate: range.endDate,
      url: range.urlFilter,
      includeDefault,
      signal: ctrl.signal,
      onDelta: (text) => {
        if (abortRef.current !== ctrl) return;
        setMessages((prev) => {
          const next = prev.slice();
          // Scan backwards to find the last assistant message and append to it.
          // tool_use messages may appear between assistant turns after tool calls.
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]!.role === "assistant") {
              next[i] = { ...next[i]!, content: next[i]!.content + text };
              break;
            }
          }
          return next;
        });
      },
      onToolUse: (name, label) => {
        if (abortRef.current !== ctrl) return;
        setMessages((prev) => [
          ...prev,
          { role: "tool_use", content: "", toolName: name, toolLabel: label },
        ]);
      },
      onToolResult: (name, data) => {
        if (abortRef.current !== ctrl) return;
        if (name !== "get_trend_data" || !data) return;
        // Attach the trend data to the last assistant message so the sparkline
        // renders below that message's text once streaming completes.
        const td = data as TrendData;
        if (!Array.isArray(td.points) || td.points.length < 2) return;
        setMessages((prev) => {
          const next = prev.slice();
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]!.role === "assistant") {
              next[i] = { ...next[i]!, trendData: td };
              break;
            }
          }
          return next;
        });
      },
    })
      .then(() => {
        if (abortRef.current === ctrl) setPending(false);
      })
      .catch((err) => {
        if (ctrl.signal.aborted || abortRef.current !== ctrl) return;
        setMessages((prev) => {
          const next = prev.slice();
          // Find the last empty assistant message and replace it with an error.
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i]!.role === "assistant" && next[i]!.content === "") {
              next[i] = {
                role: "assistant",
                content: `Couldn't reach the AI service (${String(err)}). Try again in a moment.`,
              };
              break;
            }
          }
          return next;
        });
        setPending(false);
      });
  };

  useEffect(() => {
    if (autoRanFor.current === rangeKey) return;
    autoRanFor.current = rangeKey;
    abortRef.current?.abort();
    setMessages([{ role: "user", content: DEFAULT_USER_MESSAGE }]);
    setPending(false);
    setTimeout(() => send([], true), 0);
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  const ask = (question: string) => {
    if (!question.trim() || pending) return;
    const next: Msg[] = [...messages, { role: "user", content: question.trim() }];
    setMessages(next);
    setInput("");
    send(next, false);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    ask(input);
  };

  return (
    <div className="space-y-4">
      <HowThisWorks
        summary="Chat with an AI analyst grounded in your real data — Google Search Console, GA4 (organic sessions, conversions, AI-assistant traffic), and Bing Webmaster. Every number it cites comes from those sources."
        steps={[
          { title: "Default analysis auto-runs", body: "When you change the date range or URL filter, the assistant automatically runs a default summary (winners, losers, branded vs unbranded, top actions) so you don't start with a blank chat." },
          { title: "Ask about any page or keyword", body: "Ask about any page or keyword on your site — even ones not in the current filter. The assistant fetches a fresh GSC slice on demand and answers with the actual numbers." },
          { title: "Drill into one page", body: "Set the URL filter to a page, and the assistant gets that page's full picture: GSC clicks/impressions and queries, GA4 sessions and conversions, Bing clicks, and its internal links (inbound count + anchors)." },
          { title: "Iterate", body: "Replies stream in live and the assistant keeps full conversation context, so you can refine ('now show me only branded', 'compare to prior 28 days', etc.)." },
        ]}
        faqs={[
          { title: "What data can it see?", body: "GSC (queries, pages, clicks, impressions, position, indexing, CWV), GA4 (organic sessions, engagement, key events, AI-assistant sessions), Bing Webmaster (weekly clicks/impressions), and the internal-link graph for a selected page. Nothing else — it will say so if asked beyond that." },
          { title: "Can it edit my site or trigger jobs?", body: "No. It only reads data. Any action it suggests is a recommendation you carry out yourself." },
          { title: "Why won't it answer about a future date?", body: "GSC has a ~48h reporting lag and no future data — the assistant will say so rather than guess." },
          { title: "How many follow-up data fetches can it do?", body: "Up to 5 live data lookups per conversation to keep costs bounded. After that it answers from what it already has." },
        ]}
      />
      <Card className="border-border/50">
        <CardContent className="p-0 flex flex-col h-[calc(100vh-340px)] min-h-[420px]">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-muted-foreground text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4" /> Auto-running default analysis…
                <InfoTip>When the date range or URL filter changes, the assistant automatically runs a default summary so you don't start with a blank chat.</InfoTip>
              </div>
            )}
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;

              if (m.role === "tool_use") {
                return (
                  <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground ml-10">
                    <Search className="h-3 w-3 shrink-0 animate-pulse" />
                    <span className="italic">
                      {toolUseDescription(m.toolName ?? "", m.toolLabel ?? "")}…
                    </span>
                  </div>
                );
              }

              if (m.role === "user") {
                return (
                  <div
                    key={i}
                    className="ml-auto max-w-[80%] rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground whitespace-pre-wrap"
                  >
                    {m.content}
                  </div>
                );
              }

              return (
                <div key={i} className="flex gap-3 mr-auto max-w-[88%]">
                  <div className="h-7 w-7 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center mt-0.5">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 rounded-lg bg-muted px-4 py-2 text-sm">
                    {m.content ? (
                      <>
                        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-table:my-2">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </div>
                        {m.trendData && <TrendSparkline data={m.trendData} />}
                      </>
                    ) : (
                      isLast && pending && <TypingDots />
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          <div className="border-t">
            <div className="flex gap-2 overflow-x-auto px-3 pt-3 pb-1">
              {(range.urlFilter ? URL_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  disabled={pending}
                  className={cn(
                    "shrink-0 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors",
                    "hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <form onSubmit={onSubmit} className="p-3 flex gap-2 items-end">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about traffic, conversions, Bing, AI referrals, or a specific page..."
                rows={2}
                className="resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSubmit(e);
                  }
                }}
              />
              <InfoTip>Send your question to the assistant. It has access to the current GSC date range, URL filter, and all GSC data sections. Ask about any page or keyword — it fetches fresh data on demand.</InfoTip>
              <Button type="submit" disabled={!input.trim() || pending}>
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function GscAskPage() {
  return <GscLayout><AskBody /></GscLayout>;
}
