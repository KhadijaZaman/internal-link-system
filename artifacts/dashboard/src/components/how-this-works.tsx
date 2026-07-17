import { useState, type ReactNode } from "react";
import { ChevronDown, HelpCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface HowThisWorksStep {
  title: string;
  body: ReactNode;
}

export interface HowThisWorksProps {
  /** One-line summary of what this page does. */
  summary: ReactNode;
  /** Ordered explanation of what happens when the operator uses this page. */
  steps: HowThisWorksStep[];
  /** Optional short FAQ-style entries shown below the steps. */
  faqs?: HowThisWorksStep[];
  /** Optional final tips / gotchas. */
  tips?: ReactNode[];
  /** Show open by default. Defaults to false so the panel doesn't push content. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Compact, collapsible "How this works" panel shown at the top of each
 * dashboard page. Keeps the explanation discoverable without taking screen
 * real estate from the working surface.
 */
export function HowThisWorks({
  summary,
  steps,
  faqs,
  tips,
  defaultOpen = false,
  className,
}: HowThisWorksProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("rounded-lg border border-border/60 bg-muted/30", className)}>
      <CollapsibleTrigger
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        aria-label={open ? "Hide how this works" : "Show how this works"}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <HelpCircle className="h-4 w-4 text-primary" />
          How this works
          <span className="text-muted-foreground font-normal hidden sm:inline">· {typeof summary === "string" ? summary : "click to expand"}</span>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4 pt-1 space-y-4 text-sm">
          <p className="text-muted-foreground leading-relaxed">{summary}</p>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Step by step
            </div>
            <ol className="space-y-2">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-none w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold inline-flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <div className="flex-1">
                    <div className="font-medium text-foreground">{s.title}</div>
                    <div className="text-muted-foreground leading-relaxed mt-0.5">{s.body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {faqs && faqs.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                FAQs
              </div>
              <dl className="space-y-2">
                {faqs.map((f, i) => (
                  <div key={i}>
                    <dt className="font-medium text-foreground">{f.title}</dt>
                    <dd className="text-muted-foreground leading-relaxed mt-0.5">{f.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {tips && tips.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Tips
              </div>
              <ul className="list-disc pl-5 text-muted-foreground space-y-1 leading-relaxed">
                {tips.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
