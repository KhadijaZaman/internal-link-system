import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  deltaPct,
  format = "number",
  inverted = false,
}: {
  label: string;
  value: number;
  deltaPct?: number | null;
  format?: "number" | "percent" | "decimal";
  inverted?: boolean;
}) {
  const fmt = (v: number): string => {
    if (format === "percent") return `${(v * 100).toFixed(2)}%`;
    if (format === "decimal") return v.toFixed(2);
    return Math.round(v).toLocaleString();
  };

  const showDelta = deltaPct !== null && deltaPct !== undefined && !Number.isNaN(deltaPct);
  const direction = showDelta ? (deltaPct! > 0.1 ? "up" : deltaPct! < -0.1 ? "down" : "flat") : "flat";
  const positive = inverted ? direction === "down" : direction === "up";
  const negative = inverted ? direction === "up" : direction === "down";

  return (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold mt-1">{fmt(value)}</div>
        {showDelta && (
          <div
            className={cn(
              "mt-1 text-xs font-medium flex items-center gap-1",
              positive && "text-green-600",
              negative && "text-red-500",
              !positive && !negative && "text-muted-foreground",
            )}
          >
            {direction === "up" && <ArrowUp className="h-3 w-3" />}
            {direction === "down" && <ArrowDown className="h-3 w-3" />}
            {direction === "flat" && <Minus className="h-3 w-3" />}
            {deltaPct!.toFixed(1)}% vs prev
          </div>
        )}
      </CardContent>
    </Card>
  );
}
