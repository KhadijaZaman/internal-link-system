import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface InfoTipProps {
  children: React.ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  iconClassName?: string;
}

/**
 * Inline info icon with a hover/focus tooltip explaining a section or step.
 * Usage: <InfoTip>Short helper text describing what this does.</InfoTip>
 */
export function InfoTip({
  children,
  className,
  side = "top",
  align = "center",
  iconClassName,
}: InfoTipProps) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More info"
          className={cn(
            "inline-flex items-center justify-center text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full",
            className,
          )}
        >
          <Info className={cn("h-3.5 w-3.5", iconClassName)} />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} align={align} className="max-w-xs text-xs leading-snug whitespace-normal">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
