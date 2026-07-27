export default function Slide02WhatItDoes() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute top-[14vh] left-[10vw] w-[80vw]">
        <h2 className="text-text text-[3.6vw] font-bold leading-[1.1] tracking-[-0.02em] m-0">What Linkweave does</h2>

        <div className="mt-[6vh] border-t border-line">
          <div className="flex items-baseline gap-[2.5vw] py-[2.8vh] border-b border-line">
            <div className="text-primary text-[1.1vw] font-semibold w-[3vw] shrink-0">01</div>
            <p className="text-text text-[1.7vw] leading-[1.4] m-0">Multi-tenant SEO operations hub for site owners</p>
          </div>
          <div className="flex items-baseline gap-[2.5vw] py-[2.8vh] border-b border-line">
            <div className="text-primary text-[1.1vw] font-semibold w-[3vw] shrink-0">02</div>
            <p className="text-text text-[1.7vw] leading-[1.4] m-0">Aggregates Google Search Console, Bing, GA4, and AI-citation data in one place</p>
          </div>
          <div className="flex items-baseline gap-[2.5vw] py-[2.8vh] border-b border-line">
            <div className="text-primary text-[1.1vw] font-semibold w-[3vw] shrink-0">03</div>
            <p className="text-text text-[1.7vw] leading-[1.4] m-0">Turns raw search data into ranked internal-linking and content tasks</p>
          </div>
        </div>

        <div className="mt-[5vh] flex items-center gap-[1.5vw]">
          <div className="text-accent text-[0.95vw] font-semibold uppercase tracking-[0.1em] shrink-0">Core loop</div>
          <div className="bg-bg border border-line px-[1.5vw] py-[1.8vh] text-text text-[1.4vw] font-semibold">connect sources</div>
          <div className="text-primary text-[1.8vw] font-bold">→</div>
          <div className="bg-bg border border-line px-[1.5vw] py-[1.8vh] text-text text-[1.4vw] font-semibold">background jobs analyze</div>
          <div className="text-primary text-[1.8vw] font-bold">→</div>
          <div className="bg-primary px-[1.5vw] py-[1.8vh] text-[1.4vw] font-semibold text-[#ffffff]">you execute ranked wins</div>
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[5vw] text-faint text-[0.9vw] font-semibold">02</div>
    </div>
  );
}
