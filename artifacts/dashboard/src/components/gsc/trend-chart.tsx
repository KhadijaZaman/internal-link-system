import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface Point {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const METRICS = {
  clicks: { color: "#0554F2", label: "Clicks" },
  impressions: { color: "#7C9CF6", label: "Impressions" },
  ctr: { color: "#10B981", label: "CTR" },
  position: { color: "#F59E0B", label: "Position" },
} as const;

export function TrendChart({
  data,
  metric,
}: {
  data: Point[];
  metric: keyof typeof METRICS;
}) {
  const conf = METRICS[metric];
  const reverseY = metric === "position";
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} reversed={reverseY} domain={["auto", "auto"]} />
        <Tooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey={metric}
          stroke={conf.color}
          strokeWidth={2}
          dot={false}
          name={conf.label}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
