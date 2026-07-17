import { useEffect, useState } from "react";
import { useGscRange, presetToRange, type PresetKey } from "./range-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const PRESETS: { value: PresetKey; label: string }[] = [
  { value: "28d", label: "Last 28 days" },
  { value: "3mo", label: "3 months" },
  { value: "6mo", label: "6 months" },
  { value: "12mo", label: "12 months" },
  { value: "custom", label: "Custom" },
];

export function GscControls({ showUrlFilter = true }: { showUrlFilter?: boolean }) {
  const { range, setRange } = useGscRange();

  // Debounce the URL filter: it's part of the GSC query keys, so committing on
  // every keystroke refetches every Search Console query (a quota-sensitive,
  // paid-quota API). Keep typing local and commit ~500ms after the user stops.
  const [urlInput, setUrlInput] = useState(range.urlFilter ?? "");
  useEffect(() => {
    setUrlInput(range.urlFilter ?? "");
  }, [range.urlFilter]);
  useEffect(() => {
    const next = urlInput.trim() || null;
    if (next === (range.urlFilter ?? null)) return;
    const t = setTimeout(() => setRange({ urlFilter: next }), 500);
    return () => clearTimeout(t);
  }, [urlInput, range.urlFilter, setRange]);

  const onPreset = (p: PresetKey) => {
    if (p === "custom") {
      setRange({ preset: "custom" });
      return;
    }
    const r = presetToRange(p);
    setRange({ preset: p, startDate: r.startDate, endDate: r.endDate });
  };

  return (
    <div className="border rounded-lg p-4 bg-card flex flex-col lg:flex-row gap-4 lg:items-end flex-wrap">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.value}
            size="sm"
            variant={range.preset === p.value ? "default" : "outline"}
            onClick={() => onPreset(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {range.preset === "custom" && (
        <div className="flex gap-2 items-end">
          <div>
            <Label className="text-xs text-muted-foreground">Start</Label>
            <Input
              type="date"
              value={range.startDate}
              onChange={(e) => setRange({ startDate: e.target.value })}
              className="h-9"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">End</Label>
            <Input
              type="date"
              value={range.endDate}
              onChange={(e) => setRange({ endDate: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id="compare"
          checked={range.compare}
          onCheckedChange={(v) => setRange({ compare: v })}
        />
        <Label htmlFor="compare" className="text-sm cursor-pointer">
          Compare to previous period
        </Label>
      </div>

      {showUrlFilter && (
        <div className="flex-1 min-w-[200px]">
          <Label className="text-xs text-muted-foreground">URL filter (optional)</Label>
          <Input
            placeholder="https://wellows.com/blog/..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                setRange({ urlFilter: urlInput.trim() || null });
            }}
            className="h-9"
          />
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        {range.startDate} → {range.endDate}
      </div>
    </div>
  );
}
