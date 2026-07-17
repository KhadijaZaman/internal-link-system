import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GscLayout } from "@/components/gsc/gsc-layout";
import { useGscRange } from "@/components/gsc/range-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const STREAM_URL = `${import.meta.env.BASE_URL}api/gsc/chat/stream`.replace(/\/+api/, "/api");

const SUGGESTIONS = [
  "What changed versus the previous period?",
  "Which pages are my biggest winners and losers?",
  "What are my top non-branded queries?",
  "Which queries am I ranking on page 2 for?",
  "What should I fix this week?",
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
}

async function streamChat(args: StreamArgs): Promise<void> {
  const res = await fetch(STREAM_URL, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: args.messages,
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
        // Ignore deltas from a stream that has been superseded by a newer one.
        if (abortRef.current !== ctrl) return;
        setMessages((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { role: "assistant", content: last.content + text };
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
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && last.content === "") {
            next[next.length - 1] = {
              role: "assistant",
              content: `Couldn't reach the AI service (${String(err)}). Try again in a moment.`,
            };
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
        summary="Chat with an AI analyst about your Search Console data — it has direct read access to the same metrics powering the other tabs and pulls GSC live as you ask follow-ups."
        steps={[
          { title: "Default analysis auto-runs", body: "When you change the date range or URL filter, the assistant automatically runs a default summary (winners, losers, branded vs unbranded, top actions) so you don't start with a blank chat." },
          { title: "Ask follow-up questions", body: "Type any question or tap a suggested prompt — the assistant reads the GSC slice for the selected range (queries / pages / countries / devices) and answers with the numbers." },
          { title: "Iterate", body: "Replies stream in live and the assistant keeps full conversation context, so you can refine ('now show me only branded', 'compare to prior 28 days', etc.)." },
        ]}
        faqs={[
          { title: "Can it edit my site or trigger jobs?", body: "No. It only reads from GSC. Any action it suggests is a recommendation you carry out yourself." },
          { title: "Why won't it answer about a future date?", body: "GSC has a ~48h reporting lag and no future data — the assistant will say so rather than guess." },
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
                      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-table:my-2">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
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
              {SUGGESTIONS.map((s) => (
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
                placeholder="Ask anything about this GSC slice..."
                rows={2}
                className="resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSubmit(e);
                  }
                }}
              />
              <InfoTip>Send your question to the assistant. It has access to the current GSC date range, URL filter, and all GSC data sections.</InfoTip>
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
