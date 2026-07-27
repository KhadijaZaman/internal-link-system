export default function Slide16Act2() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-accent" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Demo Script / 2026</div>
      </div>

      <div className="absolute top-[14vh] left-[10vw] w-[22vw]">
        <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] mb-[1.2vh]">Demo script · Act 2</div>
        <h2 className="text-text text-[2.7vw] font-bold leading-[1.12] tracking-[-0.02em] m-0 [text-wrap:balance]">The daily loop</h2>
        <div className="text-soft text-[10vw] font-extrabold leading-none tracking-[-0.04em] opacity-30 mt-[4vh]">02</div>
      </div>

      <div className="absolute top-[14vh] left-[37vw] w-[53vw]">
        <div className="py-[2.6vh] border-b border-line">
          <div className="inline-block border border-accent text-accent text-[0.85vw] font-semibold uppercase tracking-[0.1em] px-[0.8vw] py-[0.6vh] mb-[1.4vh]">Open Home</div>
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"Here's the morning view. Three KPIs on top, and below them Actionable Wins, ranked by impact."</p>
        </div>
        <div className="py-[2.6vh] border-b border-line">
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"I don't hunt for problems — the tool already ranked them. Win number one is worth more than the next five combined."</p>
        </div>
        <div className="py-[2.6vh] border-b border-line">
          <div className="inline-block border border-accent text-accent text-[0.85vw] font-semibold uppercase tracking-[0.1em] px-[0.8vw] py-[0.6vh] mb-[1.4vh]">Open To-Do List</div>
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"Every win becomes a task here. Clearing two or three a day is the whole habit."</p>
        </div>
        <div className="py-[2.6vh]">
          <div className="inline-block border border-accent text-accent text-[0.85vw] font-semibold uppercase tracking-[0.1em] px-[0.8vw] py-[0.6vh] mb-[1.4vh]">Open Weekly Digest</div>
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"On Friday, the digest shows what actually moved. No dashboard archaeology."</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">16</div>
    </div>
  );
}
