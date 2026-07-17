import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SortState<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

export function SortableHeader<K extends string>({
  col,
  label,
  sort,
  onChange,
  align = "right",
}: {
  col: K;
  label: string;
  sort: SortState<K>;
  onChange: (s: SortState<K>) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === col;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={cn(
        "p-3 cursor-pointer select-none hover:text-foreground transition-colors",
        align === "right" ? "text-right" : "text-left",
      )}
      onClick={() =>
        onChange({
          key: col,
          dir: active ? (sort.dir === "asc" ? "desc" : "asc") : col === "query" || col === "url" ? "asc" : "desc",
        })
      }
    >
      <span className={cn("inline-flex items-center gap-1", align === "right" ? "justify-end" : "")}>
        {label}
        <Icon className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")} />
      </span>
    </th>
  );
}
