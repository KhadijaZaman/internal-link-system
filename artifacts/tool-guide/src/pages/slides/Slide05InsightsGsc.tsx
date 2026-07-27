export default function Slide05InsightsGsc() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[13vh] left-[10vw] w-[80vw]">
        <div className="text-primary text-[1vw] font-semibold uppercase tracking-[0.12em] mb-[1.2vh]">Track performance</div>
        <h2 className="text-text text-[3.4vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">SEO Insights &amp; Google Search</h2>

        <div className="mt-[4.5vh] flex gap-[2vw]">
          <div className="flex-1 bg-bg border border-line p-[1.8vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.2vw] h-[1.2vw] bg-primary mb-[2vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1.2vh]">SEO Insights</h3>
            <p className="text-muted text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">cross-source mismatch finder (e.g. ranks well, CTR near zero)</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.8vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.2vw] h-[1.2vw] bg-soft mb-[2vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1.2vh]">Google Search</h3>
            <p className="text-muted text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">full GSC suite — queries, pages, geo, indexing, Core Web Vitals, links</p>
          </div>
        </div>

        <div className="mt-[4.5vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-primary text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Logic</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">joins GSC + Bing + GA4 + AI citations per page to expose gaps no single source shows</p>
        </div>
        <div className="mt-[2vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Use case</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">start every investigation here — find where demand exists but clicks leak</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">05</div>
    </div>
  );
}
