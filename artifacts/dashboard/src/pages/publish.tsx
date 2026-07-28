import { useState } from "react";
import { Link } from "wouter";
import {
  useGetIntegrations,
  usePublishToCms,
} from "@workspace/api-client-react";
import type { CmsPublishResult } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { HowThisWorks } from "@/components/how-this-works";
import { useToast } from "@/hooks/use-toast";
import { Send, ExternalLink, UploadCloud } from "lucide-react";

export default function PublishPage() {
  const { toast } = useToast();
  const { data: status } = useGetIntegrations();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [result, setResult] = useState<CmsPublishResult | null>(null);

  const publish = usePublishToCms({
    mutation: {
      onSuccess: (r) => {
        setResult(r);
        toast({
          title: r.status === "publish" ? "Published" : "Draft created",
          description: "The post is in your WordPress site.",
        });
      },
      onError: (err: unknown) => {
        const msg =
          (err as { data?: { error?: string } })?.data?.error ?? "Publish failed";
        toast({ title: msg, variant: "destructive" });
      },
    },
  });

  const wpConnected = status?.wp.connected ?? false;
  const canSubmit = title.trim().length > 0 && markdown.trim().length > 0 && !publish.isPending;

  const submit = (postStatus: "draft" | "publish") => {
    publish.mutate({
      data: {
        title: title.trim(),
        markdown,
        status: postStatus,
        slug: slug.trim() || null,
        excerpt: excerpt.trim() || null,
      },
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl flex items-center gap-2">
          <UploadCloud className="h-6 w-6" />
          Publish to CMS
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Push a post straight to WordPress — nothing gets copy-pasted into an editor again.
        </p>
      </div>

      <HowThisWorks
        summary="Sends a Markdown post to your connected WordPress site as a draft or live post."
        steps={[
          {
            title: "Write or paste Markdown",
            body: "Bring a draft from the Content Writer or anywhere else. Headings, lists, and links convert to clean HTML automatically.",
          },
          {
            title: "Save as draft or publish live",
            body: "Draft is the safe default — review it in wp-admin before it goes live. Publish pushes it public immediately.",
          },
          {
            title: "Get the links back",
            body: "You get the public permalink and a direct wp-admin edit link the moment the post lands.",
          },
        ]}
        tips={["Connect WordPress once in Settings → Connections with an Application Password — no plugin needed."]}
      />

      {!wpConnected ? (
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              WordPress isn't connected yet. Add your site URL and an Application Password first.
            </p>
            <Link href="/settings">
              <Button variant="outline">Open Connections</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New post</CardTitle>
            <CardDescription>
              Publishing to {status?.wp.baseUrl} as {status?.wp.username}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Post title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="input-post-title"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                placeholder="Slug (optional)"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                data-testid="input-post-slug"
              />
              <Input
                placeholder="Excerpt (optional)"
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                data-testid="input-post-excerpt"
              />
            </div>
            <Textarea
              placeholder={"# Heading\n\nPost body in Markdown…"}
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={16}
              className="font-mono text-sm"
              data-testid="input-post-markdown"
            />
            <div className="flex items-center gap-2">
              <Button
                onClick={() => submit("draft")}
                disabled={!canSubmit}
                variant="outline"
                className="gap-1.5"
                data-testid="button-save-draft"
              >
                <Send className="h-4 w-4" />
                {publish.isPending ? "Sending…" : "Save as draft"}
              </Button>
              <Button
                onClick={() => submit("publish")}
                disabled={!canSubmit}
                className="gap-1.5"
                data-testid="button-publish"
              >
                <Send className="h-4 w-4" />
                {publish.isPending ? "Sending…" : "Publish live"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result ? (
        <Card data-testid="publish-result">
          <CardContent className="py-4 flex flex-wrap items-center gap-3">
            <Badge variant={result.status === "publish" ? "default" : "secondary"}>
              {result.status === "publish" ? "live" : "draft"}
            </Badge>
            <span className="text-sm">Post #{result.postId} created.</span>
            <a href={result.link} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm" className="gap-1.5">
                View post <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </a>
            <a href={result.editLink} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm" className="gap-1.5">
                Edit in wp-admin <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </a>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
