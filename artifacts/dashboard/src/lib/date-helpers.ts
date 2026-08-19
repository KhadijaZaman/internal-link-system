import { subDays } from "date-fns";

export function getUtcWindows(weeks: number, nowStr?: string) {
  const now = nowStr ? new Date(nowStr) : new Date();
  
  // Use UTC equivalent for the date math
  const currentEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3));
  const currentStart = new Date(Date.UTC(currentEnd.getUTCFullYear(), currentEnd.getUTCMonth(), currentEnd.getUTCDate() - (weeks * 7) + 1));
  
  const priorEnd = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth(), currentStart.getUTCDate() - 1));
  const priorStart = new Date(Date.UTC(priorEnd.getUTCFullYear(), priorEnd.getUTCMonth(), priorEnd.getUTCDate() - (weeks * 7) + 1));

  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  
  return {
    currentStart: dtf.format(currentStart),
    currentEnd: dtf.format(currentEnd),
    priorStart: dtf.format(priorStart),
    priorEnd: dtf.format(priorEnd),
  };
}

export function formatWindowDate(dStr: string) {
  if (!dStr) return "";
  const d = new Date(dStr);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
}
