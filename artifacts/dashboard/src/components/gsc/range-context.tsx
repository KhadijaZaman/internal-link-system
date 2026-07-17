import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type PresetKey = "28d" | "3mo" | "6mo" | "12mo" | "custom";

export interface GscRange {
  startDate: string;
  endDate: string;
  preset: PresetKey;
  compare: boolean;
  urlFilter: string | null;
}

interface Ctx {
  range: GscRange;
  setRange: (r: Partial<GscRange>) => void;
}

const GscRangeContext = createContext<Ctx | null>(null);

function dateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function presetToRange(preset: PresetKey): { startDate: string; endDate: string } {
  switch (preset) {
    case "28d":
      return { startDate: dateOffset(28), endDate: dateOffset(1) };
    case "3mo":
      return { startDate: dateOffset(90), endDate: dateOffset(1) };
    case "6mo":
      return { startDate: dateOffset(180), endDate: dateOffset(1) };
    case "12mo":
      return { startDate: dateOffset(365), endDate: dateOffset(1) };
    case "custom":
      return { startDate: dateOffset(28), endDate: dateOffset(1) };
  }
}

export function GscRangeProvider({ children }: { children: ReactNode }) {
  const initial = presetToRange("28d");
  const [state, setState] = useState<GscRange>({
    startDate: initial.startDate,
    endDate: initial.endDate,
    preset: "28d",
    compare: true,
    urlFilter: null,
  });
  const value = useMemo<Ctx>(
    () => ({
      range: state,
      setRange: (r) => setState((prev) => ({ ...prev, ...r })),
    }),
    [state],
  );
  return <GscRangeContext.Provider value={value}>{children}</GscRangeContext.Provider>;
}

export function useGscRange(): Ctx {
  const ctx = useContext(GscRangeContext);
  if (!ctx) throw new Error("useGscRange must be used inside GscRangeProvider");
  return ctx;
}
