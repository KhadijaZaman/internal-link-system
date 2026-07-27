export default function Slide15Act1() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-accent" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Demo Script / 2026</div>
      </div>

      <div className="absolute top-[14vh] left-[10vw] w-[22vw]">
        <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.12em] mb-[1.2vh]">Demo script · Act 1</div>
        <h2 className="text-text text-[2.7vw] font-bold leading-[1.12] tracking-[-0.02em] m-0 [text-wrap:balance]">Connect &amp; first sync</h2>
        <div className="text-soft text-[10vw] font-extrabold leading-none tracking-[-0.04em] opacity-30 mt-[4vh]">01</div>
      </div>

      <div className="absolute top-[14vh] left-[37vw] w-[53vw]">
        <div className="py-[2.6vh] border-b border-line">
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"This is Linkweave. In the next ten minutes you'll see how it turns search data into a to-do list that actually moves rankings."</p>
        </div>
        <div className="py-[2.6vh] border-b border-line">
          <div className="inline-block border border-accent text-accent text-[0.85vw] font-semibold uppercase tracking-[0.1em] px-[0.8vw] py-[0.6vh] mb-[1.4vh]">Open Connections</div>
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"Setup is one screen: connect Search Console, Bing, GA4, and WordPress — OAuth, no code."</p>
        </div>
        <div className="py-[2.6vh] border-b border-line">
          <div className="inline-block border border-accent text-accent text-[0.85vw] font-semibold uppercase tracking-[0.1em] px-[0.8vw] py-[0.6vh] mb-[1.4vh]">Trigger sync</div>
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"The moment a source connects, background jobs start pulling months of history."</p>
        </div>
        <div className="py-[2.6vh]">
          <p className="text-text text-[1.6vw] leading-[1.5] m-0 [text-wrap:pretty]">"One rule to remember: every number you'll see traces back to one of these four sources."</p>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">15</div>
    </div>
  );
}
