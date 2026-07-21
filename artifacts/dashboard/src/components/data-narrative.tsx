import type { ReactNode } from "react";
import { BookOpenText } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NarrativeInsight {
  /** Short plain-English observation, numbers pre-formatted by the caller. */
  text: ReactNode;
  /** Visual tone of the bullet dot. */
  tone?: "good" | "warn" | "neutral";
}

export interface DataNarrativeProps {
  /** Card heading, e.g. "The story in plain English". */
  title?: string;
  /** 1-3 short paragraphs telling the story. Use <Num> for highlighted figures. */
  paragraphs: ReactNode[];
  /** Optional "worth noting" bullets under the story. */
  insights?: NarrativeInsight[];
  className?: string;
}

/** Inline highlighted number/term inside a narrative sentence. */
export function Num({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-foreground whitespace-nowrap">{children}</span>;
}

const dotClass: Record<NonNullable<NarrativeInsight["tone"]>, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  neutral: "bg-muted-foreground/60",
};

/**
 * Plain-English narrative block that turns the page's metrics into a short
 * story a non-technical reader can follow (impressions → ranking → clicks →
 * AI citations). Purely presentational — callers compute the numbers.
 */
export function DataNarrative({
  title = "The story in plain English",
  paragraphs,
  insights,
  className,
}: DataNarrativeProps) {
  if (paragraphs.length === 0) return null;
  return (
    <div className={cn("rounded-lg border border-primary/20 bg-primary/[0.03] p-4 space-y-3", className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <BookOpenText className="h-4 w-4 text-primary" />
        {title}
      </div>
      <div className="space-y-2">
        {paragraphs.map((p, i) => (
          <p key={i} className="text-sm text-muted-foreground leading-relaxed">
            {p}
          </p>
        ))}
      </div>
      {insights && insights.length > 0 ? (
        <ul className="space-y-1.5 pt-1">
          {insights.map((ins, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground leading-snug">
              <span
                className={cn("mt-1.5 h-1.5 w-1.5 rounded-full shrink-0", dotClass[ins.tone ?? "neutral"])}
              />
              <span>{ins.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
