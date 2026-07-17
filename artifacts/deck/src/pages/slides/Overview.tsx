export default function Overview() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[38vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            03 — Overview
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            What it does
          </h2>
        </div>

        <div className="flex-1 flex flex-col justify-center gap-[2.6vh] py-[3vh]">
          <div className="flex items-baseline gap-[2.5vw] border-b border-line pb-[2.2vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[5vw] shrink-0">01</div>
            <div className="text-[2vw] font-bold w-[16vw] shrink-0 tracking-[-0.02em]">
              Ingest
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              Search Console performance, indexing, and Core Web Vitals
            </div>
          </div>
          <div className="flex items-baseline gap-[2.5vw] border-b border-line pb-[2.2vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[5vw] shrink-0">02</div>
            <div className="text-[2vw] font-bold w-[16vw] shrink-0 tracking-[-0.02em]">
              Crawl
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              The full site and build its internal link graph
            </div>
          </div>
          <div className="flex items-baseline gap-[2.5vw] border-b border-line pb-[2.2vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[5vw] shrink-0">03</div>
            <div className="text-[2vw] font-bold w-[16vw] shrink-0 tracking-[-0.02em]">
              Suggest
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              Ranked internal links and on-demand optimization briefs
            </div>
          </div>
          <div className="flex items-baseline gap-[2.5vw] border-b border-line pb-[2.2vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[5vw] shrink-0">04</div>
            <div className="text-[2vw] font-bold w-[16vw] shrink-0 tracking-[-0.02em]">
              Audit
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              Scheduled checks for orphans, over-linking, and broken links
            </div>
          </div>
          <div className="flex items-baseline gap-[2.5vw] pb-[0.5vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[5vw] shrink-0">05</div>
            <div className="text-[2vw] font-bold w-[16vw] shrink-0 tracking-[-0.02em]">
              Review
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              A single-admin dashboard to approve results and trigger jobs
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows Internal Linking
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">03</div>
        </div>
      </div>
    </div>
  );
}
