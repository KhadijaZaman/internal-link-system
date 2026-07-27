export default function Slide03Organization() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[14vh] left-[10vw] w-[46vw]">
        <h2 className="text-text text-[3.6vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">How the tool is organized</h2>

        <div className="mt-[6vh] border-t border-line">
          <div className="py-[3vh] border-b border-line">
            <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]"><span className="font-semibold">Five sidebar zones:</span> Daily loop, Track performance, Improve linking, Improve content, Setup</p>
          </div>
          <div className="py-[3vh] border-b border-line">
            <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]"><span className="font-semibold">Logic:</span> measure first, then fix links, then fix content</p>
          </div>
          <div className="py-[3vh] border-b border-line">
            <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]"><span className="font-semibold">Every page answers one question:</span> what changed, why, and what to do next</p>
          </div>
          <div className="py-[3vh] border-b border-line">
            <p className="text-text text-[1.6vw] leading-[1.45] m-0 [text-wrap:pretty]"><span className="font-semibold">Admin-only extras:</span> user overview, global syncs, authority report</p>
          </div>
        </div>
      </div>

      <div className="absolute top-[16vh] left-[62vw] w-[28vw]">
        <div className="bg-primary px-[1.6vw] py-[2.4vh] text-[1.25vw] font-semibold text-[#ffffff]">Daily loop</div>
        <div className="bg-bg border border-line border-t-0 px-[1.6vw] py-[2.4vh] flex items-center gap-[1vw]">
          <div className="w-[0.9vw] h-[0.9vw] bg-soft shrink-0" />
          <div className="text-text text-[1.25vw] font-semibold">Track performance</div>
        </div>
        <div className="bg-bg border border-line border-t-0 px-[1.6vw] py-[2.4vh] flex items-center gap-[1vw]">
          <div className="w-[0.9vw] h-[0.9vw] bg-accent shrink-0" />
          <div className="text-text text-[1.25vw] font-semibold">Improve linking</div>
        </div>
        <div className="bg-bg border border-line border-t-0 px-[1.6vw] py-[2.4vh] flex items-center gap-[1vw]">
          <div className="w-[0.9vw] h-[0.9vw] bg-primary shrink-0" />
          <div className="text-text text-[1.25vw] font-semibold">Improve content</div>
        </div>
        <div className="bg-bg border border-line border-t-0 px-[1.6vw] py-[2.4vh] flex items-center gap-[1vw]">
          <div className="w-[0.9vw] h-[0.9vw] bg-soft shrink-0" />
          <div className="text-text text-[1.25vw] font-semibold">Setup</div>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">03</div>
    </div>
  );
}
