import {
  useGetUrlLinkBreakdown,
  getGetUrlLinkBreakdownQueryKey,
  type UrlLinkRef,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { ArrowUpRight, ArrowDownLeft, ExternalLink, Link2 } from "lucide-react";
import { InfoTip } from "@/components/info-tip";

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = (u.pathname + u.search).replace(/\/$/, "");
    return p || "/";
  } catch {
    return url;
  }
}

export function LinkBreakdownDrawer({
  url,
  onClose,
}: {
  url: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useGetUrlLinkBreakdown(
    { url: url ?? "" },
    {
      query: {
        enabled: !!url,
        queryKey: getGetUrlLinkBreakdownQueryKey({ url: url ?? "" }),
      },
    },
  );

  return (
    <Drawer open={!!url} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent className="h-[88vh]">
        <div className="max-w-5xl w-full mx-auto flex flex-col h-full">
          <DrawerHeader className="border-b pb-5 px-6 shrink-0">
            <DrawerTitle className="font-display tracking-wide text-2xl text-primary flex items-center gap-2">
              <Link2 className="h-5 w-5" /> Internal Links
            </DrawerTitle>
            <DrawerDescription className="text-base text-foreground mt-1">
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1 font-mono break-all"
                  title={`Open ${url} in a new tab`}
                >
                  <span className="break-all">{url}</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </a>
              )}
            </DrawerDescription>
          </DrawerHeader>

          {isLoading || !data ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner className="h-8 w-8" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-5 grid md:grid-cols-2 gap-6">
              <LinkColumn
                title="Internal links"
                hint="Same-domain in-body links this page points to (outgoing)."
                icon={<ArrowUpRight className="h-4 w-4" />}
                count={data.outgoingCount}
                refs={data.outgoing}
                emptyText="This page has no in-body links to other pages on your site."
              />
              <LinkColumn
                title="Internal backlinks"
                hint="Same-domain in-body links from other pages pointing back here (incoming)."
                icon={<ArrowDownLeft className="h-4 w-4" />}
                count={data.incomingCount}
                refs={data.incoming}
                emptyText="No other page links to this one from its body content."
              />
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function LinkColumn({
  title,
  hint,
  icon,
  count,
  refs,
  emptyText,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  count: number;
  refs: UrlLinkRef[];
  emptyText: string;
}) {
  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-muted-foreground">{icon}</span>
        <h4 className="font-semibold">{title}</h4>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
        <InfoTip>{hint}</InfoTip>
      </div>
      {refs.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-md border border-dashed border-border/60 px-4 py-6 text-center">
          {emptyText}
        </div>
      ) : (
        <ul className="space-y-2">
          {refs.map((r) => (
            <li
              key={r.url}
              className="rounded-md border border-border/60 px-3 py-2 hover:bg-muted/30 transition-colors"
            >
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-sm hover:text-primary inline-flex items-center gap-1"
                title={`Open ${r.url} in a new tab`}
              >
                <span className="break-words">{r.title || pathOf(r.url)}</span>
                <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              </a>
              <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                {pathOf(r.url)}
              </div>
              {r.anchorTexts.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {r.anchorTexts.map((a, i) => (
                    <Badge key={i} variant="outline" className="font-normal text-[11px]">
                      “{a}”
                    </Badge>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
