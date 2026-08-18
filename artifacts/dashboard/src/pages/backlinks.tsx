import { HowThisWorks } from "@/components/how-this-works";
import { BacklinkAuditSection } from "@/components/backlink-audit";
import { Link2 } from "lucide-react";

export default function BacklinksPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl flex items-center gap-2">
          <Link2 className="h-6 w-6" />
          Backlinks
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          A summary of your site's own backlink profile — authority, anchors, top backlinks,
          referring domains, and toxic-link review.
        </p>
      </div>

      <HowThisWorks
        summary="Audits your own backlink profile so you can see what links to you and spot risky links."
        steps={[
          {
            title: "Run the audit",
            body: "Pulls your site's live backlink profile (cached for 24 hours, so re-running is free within a day).",
          },
          {
            title: "Review the profile",
            body: "Authority rank, backlink and referring-domain counts, anchor-text distribution, and your strongest individual backlinks.",
          },
          {
            title: "Handle risky links",
            body: "Flagged low-quality or spammy referring domains can be reviewed and exported as a disavow file.",
          },
        ]}
        tips={[
          "A few links from high-authority, topically relevant domains beat hundreds of low-quality ones.",
        ]}
      />

      <BacklinkAuditSection />
    </div>
  );
}
