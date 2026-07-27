export default function Slide13SetupGovernance() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[13vh] left-[10vw] w-[80vw]">
        <h2 className="text-text text-[3.6vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">Setup &amp; governance</h2>

        <div className="mt-[4.5vh] flex gap-[1.5vw]">
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-primary mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Connections</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">OAuth for Search Console, Bing, GA4, and WordPress</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-soft mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Page Classifications</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">label URLs (blog, product, docs) — every report filters by type</p>
          </div>
        </div>
        <div className="mt-[1.5vw] flex gap-[1.5vw]">
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-accent mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Excluded URLs</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">keep legal, privacy, and thin pages out of all suggestions</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-primary mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Admin</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">all users, connection status, global sync triggers — admin-gated</p>
          </div>
        </div>

        <div className="mt-[4vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-primary text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Logic</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">multi-tenant — every site's data isolated behind ownership checks</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">13</div>
    </div>
  );
}
