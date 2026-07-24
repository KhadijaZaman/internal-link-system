// Pure color-coding logic for the "Target Keyword Daily Movement" sheet.
// No I/O — unit-tested. Rules (operator-approved):
//   - green  = improvement (day-over-day on keyword tabs, last-7d vs prior-7d
//              on the summary tab)
//   - red    = decline
//   - orange = new record within the tracking window (a day/week where the
//              metric beat every earlier value: more impressions/clicks than
//              ever before, or a better position than ever before). Orange is
//              painted on the metric VALUE cell; green/red on the CHANGE cell.

export type CellColor = "green" | "red" | "orange" | null;

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface DailyMetricRow {
  impressions: number;
  clicks: number;
  position: number;
}

/** Per-day series plus day-over-day changes, exactly as displayed on a
 * keyword tab. Position change carries the last KNOWN position across
 * no-data days (null = no value shown in the cell). */
export interface DailyComputed {
  impr: number[];
  imprChange: Array<number | null>;
  clicks: number[];
  clicksChange: Array<number | null>;
  pos: Array<number | null>;
  posChange: Array<number | null>;
}

export function computeDaily(
  days: Array<DailyMetricRow | undefined>,
): DailyComputed {
  const impr: number[] = [];
  const imprChange: Array<number | null> = [];
  const clicks: number[] = [];
  const clicksChange: Array<number | null> = [];
  const pos: Array<number | null> = [];
  const posChange: Array<number | null> = [];

  let prevImpr: number | null = null;
  let prevClicks: number | null = null;
  let prevPos: number | null = null;
  for (const row of days) {
    const im = Math.round(row?.impressions ?? 0);
    const ck = Math.round(row?.clicks ?? 0);
    const po = row && row.impressions > 0 ? round1(row.position) : null;

    impr.push(im);
    imprChange.push(prevImpr == null ? null : im - prevImpr);
    clicks.push(ck);
    clicksChange.push(prevClicks == null ? null : ck - prevClicks);
    pos.push(po);
    posChange.push(po != null && prevPos != null ? round1(prevPos - po) : null);

    prevImpr = im;
    prevClicks = ck;
    if (po != null) prevPos = po;
  }
  return { impr, imprChange, clicks, clicksChange, pos, posChange };
}

/** Green when the change is positive (for position change, positive already
 * means "moved up"), red when negative, uncolored at zero/no data. */
export function changeColor(v: number | null): CellColor {
  if (v == null || v === 0) return null;
  return v > 0 ? "green" : "red";
}

/**
 * Flags days that set a NEW RECORD within the window: the value strictly
 * beats every earlier non-null value. The first day with data only sets the
 * baseline (nothing earlier to beat), and for "higher" metrics a record must
 * also be > 0 (a string of zeros never counts as a record).
 */
export function newRecordFlags(
  values: Array<number | null>,
  better: "higher" | "lower",
): boolean[] {
  const flags: boolean[] = [];
  let best: number | null = null;
  for (const v of values) {
    if (v == null) {
      flags.push(false);
      continue;
    }
    if (best == null) {
      flags.push(false);
      best = v;
      continue;
    }
    const isRecord =
      better === "higher" ? v > best && v > 0 : v < best;
    flags.push(isRecord);
    best = better === "higher" ? Math.max(best, v) : Math.min(best, v);
  }
  return flags;
}

/** 6 rows of background colors for a keyword tab's data area (rows
 * Impressions / Impr change / Clicks / Clicks change / Position / Position
 * change), one entry per day column. */
export function keywordTabColorMatrix(d: DailyComputed): CellColor[][] {
  const imprRec = newRecordFlags(d.impr, "higher");
  const clicksRec = newRecordFlags(d.clicks, "higher");
  const posRec = newRecordFlags(d.pos, "lower");
  const orange = (f: boolean): CellColor => (f ? "orange" : null);
  return [
    imprRec.map(orange),
    d.imprChange.map(changeColor),
    clicksRec.map(orange),
    d.clicksChange.map(changeColor),
    posRec.map(orange),
    d.posChange.map(changeColor),
  ];
}

/**
 * Whether the FINAL 7-day window is the best 7-day stretch of the whole
 * tracking period: strictly more impressions/clicks than every earlier
 * rolling 7-day window, or a strictly better (lower) impression-weighted
 * position than every earlier window that had data. All false when the
 * window doesn't have at least one full earlier window to compare against.
 */
export function bestWeekFlags(d: DailyComputed): {
  impr: boolean;
  clicks: boolean;
  pos: boolean;
} {
  const n = d.impr.length;
  const W = 7;
  if (n < W + 1) return { impr: false, clicks: false, pos: false };

  const rollingSums = (vals: number[]): number[] => {
    const out: number[] = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += vals[i]!;
      if (i >= W) s -= vals[i - W]!;
      if (i >= W - 1) out.push(s);
    }
    return out;
  };
  const lastIsRecord = (sums: number[]): boolean => {
    const last = sums[sums.length - 1]!;
    if (last <= 0) return false;
    for (let i = 0; i < sums.length - 1; i++) {
      if (sums[i]! >= last) return false;
    }
    return true;
  };

  const posWindows: Array<number | null> = [];
  for (let end = W - 1; end < n; end++) {
    let sum = 0;
    let weight = 0;
    for (let i = end - W + 1; i <= end; i++) {
      const p = d.pos[i];
      const im = d.impr[i]!;
      if (p != null && im > 0) {
        sum += p * im;
        weight += im;
      }
    }
    posWindows.push(weight > 0 ? sum / weight : null);
  }
  const lastPos = posWindows[posWindows.length - 1] ?? null;
  let posRecord = false;
  if (lastPos != null) {
    let sawPrior = false;
    posRecord = true;
    for (let i = 0; i < posWindows.length - 1; i++) {
      const p = posWindows[i];
      if (p == null) continue;
      sawPrior = true;
      if (p <= lastPos) {
        posRecord = false;
        break;
      }
    }
    if (!sawPrior) posRecord = false;
  }

  return {
    impr: lastIsRecord(rollingSums(d.impr)),
    clicks: lastIsRecord(rollingSums(d.clicks)),
    pos: posRecord,
  };
}
