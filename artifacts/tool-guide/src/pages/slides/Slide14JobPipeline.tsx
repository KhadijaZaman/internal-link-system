export default function Slide14JobPipeline() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[13vh] left-[10vw] w-[80vw]">
        <div className="text-primary text-[1vw] font-semibold uppercase tracking-[0.12em] mb-[1.2vh]">Under the hood</div>
        <h2 className="text-text text-[3.4vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">The job pipeline</h2>

        <div className="mt-[4.5vh] flex items-stretch gap-[1.2vw]">
          <div className="flex-1 bg-bg border border-line p-[1.6vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="text-primary text-[0.95vw] font-semibold uppercase tracking-[0.12em] mb-[1.4vh]">Ingest</div>
            <p className="text-text text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">WordPress crawl, link-map crawl, GSC / GA4 / Bing syncs — per-site, isolated failures</p>
          </div>
          <div className="self-center text-primary text-[1.8vw] font-bold shrink-0">→</div>
          <div className="flex-1 bg-bg border border-line p-[1.6vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="text-primary text-[0.95vw] font-semibold uppercase tracking-[0.12em] mb-[1.4vh]">Process</div>
            <p className="text-text text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">semantic linking, keyword clustering, similarity, topical-map generation</p>
          </div>
          <div className="self-center text-primary text-[1.8vw] font-bold shrink-0">→</div>
          <div className="flex-1 bg-bg border border-line p-[1.6vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] mb-[1.4vh]">Audit</div>
            <p className="text-text text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">orphan, broken-link, and link-quality checks</p>
          </div>
        </div>

        <div className="mt-[4.5vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-primary text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Logic</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">scheduled jobs with heartbeats — every page you saw is a job's output surface</p>
        </div>
        <div className="mt-[2vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Use case</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">nothing to babysit — data refreshes itself, failures surface as clear statuses</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">14</div>
    </div>
  );
}
