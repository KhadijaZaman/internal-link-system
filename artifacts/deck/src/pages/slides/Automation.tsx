export default function Automation() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[22vw] w-px h-screen bg-line" />

      <div className="absolute top-[5vh] right-[5vw] w-[2.2vw] h-[2.2vw] bg-accent" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            07 — Automation
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            A weekly cadence
          </h2>
        </div>

        <div className="flex flex-col mb-[2vh]">
          <div className="flex items-baseline gap-[4vw] border-b border-line py-[1.5vh]">
            <div className="text-[1.5vw] font-bold uppercase tracking-[0.12em] w-[14vw] shrink-0">
              Sun
            </div>
            <div className="text-[1.8vw] text-muted">WordPress content crawl</div>
          </div>
          <div className="flex items-baseline gap-[4vw] border-b border-line py-[1.5vh]">
            <div className="text-[1.5vw] font-bold uppercase tracking-[0.12em] w-[14vw] shrink-0">
              Mon
            </div>
            <div className="text-[1.8vw] text-muted">
              Search Console ingest and loser report
            </div>
          </div>
          <div className="flex items-baseline gap-[4vw] border-b border-line py-[1.5vh]">
            <div className="text-[1.5vw] font-bold uppercase tracking-[0.12em] w-[14vw] shrink-0">
              Tue
            </div>
            <div className="text-[1.8vw] text-muted">Semantic linking run</div>
          </div>
          <div className="flex items-baseline gap-[4vw] border-b border-line py-[1.5vh]">
            <div className="text-[1.5vw] font-bold uppercase tracking-[0.12em] w-[14vw] shrink-0">
              Thu
            </div>
            <div className="text-[1.8vw] text-muted">
              Audits: orphans, over-linking, broken links
            </div>
          </div>
          <div className="flex items-baseline gap-[4vw] border-b border-line py-[1.5vh]">
            <div className="text-[1.5vw] font-bold uppercase tracking-[0.12em] w-[14vw] shrink-0">
              Sat
            </div>
            <div className="text-[1.8vw] text-muted">Sitemap cross-check</div>
          </div>
          <div className="flex items-baseline gap-[4vw] py-[1.5vh]">
            <div className="text-[1.5vw] font-bold uppercase tracking-[0.12em] w-[14vw] shrink-0 text-accent">
              1st
            </div>
            <div className="text-[1.8vw] text-muted">
              Monthly full re-embed and re-classify
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] text-text max-w-[60vw] leading-[1.45]">
            Optimization briefs run on-demand only — paid-token spend stays
            manual.
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">07</div>
        </div>
      </div>
    </div>
  );
}
