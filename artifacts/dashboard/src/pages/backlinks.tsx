import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBacklinkProspects,
  useDiscoverBacklinkProspects,
  useUpdateBacklinkProspect,
  getListBacklinkProspectsQueryKey,
} from "@workspace/api-client-react";
import type { BacklinkProspect } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HowThisWorks } from "@/components/how-this-works";
import { BacklinkAuditSection } from "@/components/backlink-audit";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Link2, Search, ExternalLink } from "lucide-react";

const STATUSES = ["new", "contacted", "replied", "linked", "rejected"] as const;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  new: "secondary",
  contacted: "outline",
  replied: "outline",
  linked: "default",
  rejected: "destructive",
};

function ProspectRow({ prospect }: { prospect: BacklinkProspect }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [notes, setNotes] = useState(prospect.notes);
  const update = useUpdateBacklinkProspect({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBacklinkProspectsQueryKey() });
      },
      onError: () => toast({ title: "Update failed", variant: "destructive" }),
    },
  });

  return (
    <TableRow data-testid={`prospect-${prospect.domain}`}>
      <TableCell>
        <a
          href={`https://${prospect.domain}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:underline"
        >
          {prospect.domain}
          <ExternalLink className="h-3 w-3 text-muted-foreground" />
        </a>
      </TableCell>
      <TableCell className="tabular-nums">{prospect.rank ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{prospect.backlinks.toLocaleString()}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {prospect.competitorsLinking.map((c) => (
            <Badge key={c} variant="outline" className="text-xs">
              {c}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Select
          value={prospect.status}
          onValueChange={(status) =>
            update.mutate({ prospectId: prospect.id, data: { status: status as BacklinkProspect["status"] } })
          }
        >
          <SelectTrigger className="w-32 h-8" data-testid={`status-${prospect.domain}`}>
            <SelectValue>
              <Badge variant={STATUS_VARIANT[prospect.status] ?? "secondary"}>{prospect.status}</Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input
          value={notes}
          placeholder="Notes…"
          className="h-8 min-w-40"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if (notes !== prospect.notes) {
              update.mutate({ prospectId: prospect.id, data: { notes } });
            }
          }}
          data-testid={`notes-${prospect.domain}`}
        />
      </TableCell>
    </TableRow>
  );
}

export default function BacklinksPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListBacklinkProspects();
  const [competitorsInput, setCompetitorsInput] = useState("");

  const discover = useDiscoverBacklinkProspects({
    mutation: {
      onSuccess: (fresh) => {
        queryClient.setQueryData(getListBacklinkProspectsQueryKey(), fresh);
        toast({ title: "Discovery complete", description: `${fresh.prospects.length} prospects tracked.` });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { data?: { error?: string } })?.data?.error ?? "Discovery failed";
        toast({ title: msg, variant: "destructive" });
      },
    },
  });

  const prospects = data?.prospects ?? [];

  const runDiscovery = () => {
    const competitors = competitorsInput
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (competitors.length === 0) return;
    discover.mutate({ data: { competitors } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl flex items-center gap-2">
          <Link2 className="h-6 w-6" />
          Backlink Prospects
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Domains that already link to your competitors but not to you — pre-qualified outreach
          targets, ranked by authority and overlap.
        </p>
      </div>

      <HowThisWorks
        summary="Finds domains linking to competitors but not to you, then tracks your outreach per domain."
        steps={[
          {
            title: "Enter 1–5 competitor domains",
            body: "Domains in your niche whose backlink profile you want to mine. The pull is cached for 6 hours, so re-running is free.",
          },
          {
            title: "Review the gap list",
            body: "Every domain shown links to at least one competitor and not to you. Sorted by how many competitors it links to, then by domain authority.",
          },
          {
            title: "Track outreach",
            body: "Set a status (contacted, replied, replied, linked, rejected) and keep notes per prospect — nothing falls through the cracks.",
          },
        ]}
        tips={[
          "A domain linking to two or more of your competitors is the warmest possible target — they already link out to sites exactly like yours.",
        ]}
      />

      <Card>
        <CardContent className="pt-6">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runDiscovery();
            }}
          >
            <Input
              placeholder="Competitor domains, comma-separated (e.g. competitor1.com, competitor2.com)"
              value={competitorsInput}
              onChange={(e) => setCompetitorsInput(e.target.value)}
              data-testid="input-competitors"
            />
            <Button
              type="submit"
              disabled={!competitorsInput.trim() || discover.isPending}
              className="gap-1.5 shrink-0"
              data-testid="button-discover"
            >
              <Search className="h-4 w-4" />
              {discover.isPending ? "Searching…" : "Find prospects"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : prospects.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No prospects yet. Enter competitor domains above to mine their backlink profiles.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Authority</TableHead>
                  <TableHead>Backlinks</TableHead>
                  <TableHead>Links to</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prospects.map((p) => (
                  <ProspectRow key={p.id} prospect={p} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Separator className="my-2" />

      <BacklinkAuditSection />
    </div>
  );
}
