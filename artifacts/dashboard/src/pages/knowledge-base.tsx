import { useState } from "react";
import {
  useListKbDocuments,
  useAddKbDocument,
  useDeleteKbDocument,
  getListKbDocumentsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/info-tip";
import { HowThisWorks } from "@/components/how-this-works";

export default function KnowledgeBase() {
  const { data, isLoading, error } = useListKbDocuments({
    query: {
      queryKey: getListKbDocumentsQueryKey(),
      // Poll while any document is still embedding in the background so the
      // status badges flip to Ready without a manual refresh.
      refetchInterval: (q) =>
        (q.state.data ?? []).some((d) => d.embedStatus === "pending")
          ? 4000
          : false,
    },
  });
  const qc = useQueryClient();
  const add = useAddKbDocument();
  const del = useDeleteKbDocument();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const refresh = () =>
    qc.invalidateQueries({ queryKey: getListKbDocumentsQueryKey() });

  const docs = data ?? [];

  const handleAdd = () => {
    const t = title.trim();
    const c = content.trim();
    if (!t || !c) return;
    add.mutate(
      { data: { title: t, content: c } },
      {
        onSuccess: (doc) => {
          toast({
            title: `Uploaded — ${doc.chunkCount} chunks stored`,
            description:
              "Embedding runs in the background; the document shows Ready when done.",
          });
          setTitle("");
          setContent("");
          refresh();
        },
        onError: () =>
          toast({ title: "Upload failed", variant: "destructive" }),
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
          Knowledge Base
          <InfoTip>
            Operator-uploaded source material (e.g. Koray Tugberk Gubur semantic
            SEO transcripts) that grounds the optimizer. Each document is chunked
            and embedded on upload; the most relevant passages are injected into
            every optimization brief.
          </InfoTip>
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Ground optimization briefs in your own SEO source material.
        </p>
      </div>

      <HowThisWorks
        summary="Paste long-form SEO source material (transcripts, frameworks, playbooks). On upload it is split into overlapping passages and embedded. When a brief is generated, the passages most relevant to that page's primary query are retrieved and injected as grounding context."
        steps={[
          {
            title: "Upload a document",
            body: "Give it a title and paste the full text. It is chunked at paragraph boundaries (~1,400 chars, ~150 overlap) and each chunk is embedded with text-embedding-3-small.",
          },
          {
            title: "Retrieval at brief time",
            body: "When the optimizer builds a brief, it embeds the page's primary query + title + H1, scores every chunk by cosine similarity, and injects the top 5 passages (capped at ~6,000 chars) into the prompt.",
          },
          {
            title: "Fail-soft",
            body: "If the knowledge base is empty or retrieval fails, brief generation continues ungrounded — nothing breaks.",
          },
        ]}
        faqs={[
          {
            title: "What should I upload?",
            body: "Durable semantic-SEO principles you want every brief to reflect — Koray transcripts, your own playbooks, EEAT guidance. Avoid one-off page notes; use per-page target keywords for those.",
          },
          {
            title: "Does deleting a document remove its passages?",
            body: "Yes. Deleting a document cascades to all of its chunks, so they stop influencing future briefs immediately.",
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Upload document
            <InfoTip>
              Title is for your reference. Content can be up to ~500,000
              characters; it is chunked and embedded on save.
            </InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Title (e.g. Koray — Topical Authority transcript)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
          />
          <Textarea
            placeholder="Paste the full transcript or source text here…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            className="font-mono text-sm"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {content.length.toLocaleString()} characters
            </span>
            <Button
              onClick={handleAdd}
              disabled={add.isPending || !title.trim() || !content.trim()}
            >
              <Upload className="h-4 w-4 mr-1" />
              {add.isPending ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Documents ({docs.length})
            <InfoTip>
              All source documents currently grounding the optimizer. Delete one
              to stop its passages from influencing future briefs.
            </InfoTip>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : error ? (
            <div className="text-destructive py-12 text-center">
              Failed to load
            </div>
          ) : docs.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center">
              No documents yet. Upload a transcript above to start grounding
              briefs.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-1">
                      Status
                      <InfoTip>
                        Embedding… — passages are being embedded in the
                        background. Ready — all passages can ground briefs.
                        Partial — some passages failed to embed; they retry
                        automatically the next time a document is uploaded.
                      </InfoTip>
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Characters</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.title}</TableCell>
                    <TableCell>
                      {d.embedStatus === "pending" ? (
                        <Badge variant="secondary" className="gap-1">
                          <Spinner className="h-3 w-3" />
                          Embedding…
                        </Badge>
                      ) : d.embedStatus === "partial" ? (
                        <Badge variant="outline" className="text-amber-600 border-amber-600/50">
                          Partial {d.embeddedChunkCount}/{d.chunkCount}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-emerald-600 border-emerald-600/50">
                          Ready
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {d.charCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {d.chunkCount}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {d.createdAt
                        ? new Date(d.createdAt).toLocaleDateString()
                        : "-"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(d.id)}
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
