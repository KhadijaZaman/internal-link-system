export default function Slide12MapsSimilarity() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[13vh] left-[10vw] w-[80vw]">
        <div className="text-primary text-[1vw] font-semibold uppercase tracking-[0.12em] mb-[1.2vh]">Improve content</div>
        <h2 className="text-text text-[3.4vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">Maps, similarity &amp; submissions</h2>

        <div className="mt-[4vh] flex gap-[1.5vw]">
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-primary mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Topical Map</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">topics you cover vs topics you're missing</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-soft mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Content Similarity</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">near-duplicate detection — stop cannibalization before publishing</p>
          </div>
        </div>
        <div className="mt-[1.5vw] flex gap-[1.5vw]">
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-accent mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">Knowledge Base</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">curated facts that ground every AI feature</p>
          </div>
          <div className="flex-1 bg-bg border border-line p-[1.4vw] shadow-[0_1vh_2vh_rgba(0,0,0,0.02)]">
            <div className="w-[1.1vw] h-[1.1vw] bg-primary mb-[1.6vh]" />
            <h3 className="text-text text-[1.5vw] font-semibold m-0 mb-[1vh]">My Submissions</h3>
            <p className="text-muted text-[1.5vw] leading-[1.45] m-0 [text-wrap:pretty]">manual URL checklist — tracked without triggering paid crawls or AI spend</p>
          </div>
        </div>

        <div className="mt-[4vh] border-t border-line flex items-baseline gap-[2vw] pt-[2.4vh]">
          <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] w-[8vw] shrink-0">Use case</div>
          <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]">plan the next quarter of content from actual coverage gaps</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">12</div>
    </div>
  );
}
