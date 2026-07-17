import { useState } from "react";
import {
  useListWpExcludeList,
  useAddWpExclude,
  useDeleteWpExclude,
  getListWpExcludeListQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Trash2, Plus } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";
import { CopyButton } from "@/components/copy-button";
import { rowsToTsv } from "@/lib/clipboard";

export default function WpExcludeList() {
  const { data, isLoading, error } = useListWpExcludeList();
  const qc = useQueryClient();
  const add = useAddWpExclude();
  const del = useDeleteWpExclude();
  const { toast } = useToast();
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  const refresh = () =>
    qc.invalidateQueries({ queryKey: getListWpExcludeListQueryKey() });

  const handleAdd = () => {
    if (!pattern.trim()) return;
    add.mutate(
      { data: { pattern: pattern.trim(), note: note.trim() || null } },
      {
        onSuccess: () => {
          toast({ title: "Added" });
          setPattern("");
          setNote("");
          refresh();
        },
        onError: () => toast({ title: "Failed (maybe duplicate)", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    del.mutate({ id }, { onSuccess: () => refresh() });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-display text-foreground flex items-center gap-2">
          Link Exclude List
          <InfoTip>URL patterns that should never appear as link targets or sources in semantic link suggestions — for example legal pages, thank-you pages, or login flows.</InfoTip>
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          URL patterns excluded from internal link suggestions (legal, thank-you, etc).
        </p>
      </div>

      <HowThisWorks
        summary="Block list of URL patterns the semantic linker must ignore as either source or target — typically legal pages, login flows, thank-you redirects, and ephemeral campaign URLs."
        steps={[
          { title: "Add a pattern", body: "Use a literal path like /thank-you to match one URL, or a wildcard like /legal/* to match a whole folder. Patterns are admin-managed and stored in the link_exclude_list table." },
          { title: "Pattern compiles to a regex", body: "Special characters are escaped automatically, then * is expanded to .*. You don't need to know regex." },
          { title: "Linker honors it everywhere", body: "Semantic linking, link lookups, and audits all consult the same list when scoring sources and targets." },
        ]}
        faqs={[
          { title: "Does this remove existing proposals?", body: "Yes — on the next semantic linking run, any pending proposals that touch an excluded URL are dropped." },
          { title: "Will excluded pages still show in the link map?", body: "Yes. The exclude list only governs link suggestions; the graph still visualizes existing links to and from these pages." },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Add pattern
            <InfoTip>Add a new URL pattern to exclude. Use a literal path like /thank-you or a wildcard like /legal/* to match a whole folder.</InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 items-center">
          <Input
            placeholder="/thank-you or /legal/*"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="font-mono"
          />
          <Input
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <InfoTip>Save this exclusion. Existing link suggestions are not retroactively removed — but future runs will skip these URLs.</InfoTip>
          <Button onClick={handleAdd} disabled={add.isPending || !pattern.trim()}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              Excluded patterns ({data?.items.length ?? 0})
              <InfoTip>All currently active exclusions. Click the trash icon to remove one — future linking runs will then consider that URL again.</InfoTip>
            </CardTitle>
            <CopyButton
              getText={() =>
                rowsToTsv(
                  ["Pattern", "Note", "Added"],
                  (data?.items ?? []).map((i) => [
                    i.pattern,
                    i.note ?? "",
                    i.createdAt ? new Date(i.createdAt).toLocaleDateString() : "",
                  ]),
                )
              }
              disabled={(data?.items.length ?? 0) === 0}
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : error ? (
            <div className="text-destructive py-12 text-center">Failed to load</div>
          ) : (data?.items.length ?? 0) === 0 ? (
            <div className="text-muted-foreground py-12 text-center">No patterns yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pattern</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-sm">{i.pattern}</TableCell>
                    <TableCell className="text-muted-foreground">{i.note ?? "-"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {i.createdAt ? new Date(i.createdAt).toLocaleDateString() : "-"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(i.id)}
                        disabled={del.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
