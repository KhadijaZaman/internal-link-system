export default function Slide10LinkMapGraph() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[13vh] left-[10vw] w-[80vw]">
        <div className="text-primary text-[1vw] font-semibold uppercase tracking-[0.12em] mb-[1.2vh]">Improve linking</div>
        <h2 className="text-text text-[3.2vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">Link Map, Knowledge Graph, Site Authority</h2>

        <div className="mt-[4.5vh] flex gap-[2vw]">
          <div className="flex-1 bg-bg border border-line p-[1.8vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.2vw] h-[1.2vw] bg-primary mb-[2vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1.2vh]">Link Map</h3>
            <p className="text-muted text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">your internal link structure as an interactive graph</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.8vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.2vw] h-[1.2vw] bg-soft mb-[2vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1.2vh]">Knowledge Graph</h3>
            <p className="text-muted text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">content mapped to entities and topics</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.8vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.2vw] h-[1.2vw] bg-accent mb-[2vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1.2vh]">Site Authority</h3>
            <p className="text-muted text-[1.5vw] leading-[1.5] m-0 [text-wrap:pretty]">topical-focus snapshot, plus the external authority report (admin)</p>
          </div>
        </div>

        <div className="mt-[4.5vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-primary text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Logic</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">the crawler counts real in-content links — nav and sidebar links excluded</p>
        </div>
        <div className="mt-[2vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Use case</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">spot content silos and over-linked hubs before they hurt rankings</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">10</div>
    </div>
  );
}
