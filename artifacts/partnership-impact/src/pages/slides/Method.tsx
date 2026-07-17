export default function Method() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[38vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            02 — What We Measured
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            The method
          </h2>
        </div>

        <div className="flex-1 flex flex-col justify-center gap-[2.8vh] py-[3vh]">
          <div className="flex items-baseline gap-[2.5vw] border-b border-line pb-[2.4vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[4vw] shrink-0">01</div>
            <div className="text-[2vw] font-bold w-[15vw] shrink-0 tracking-[-0.02em]">
              Compare
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              Months with a partnership round against months without one (control)
            </div>
          </div>
          <div className="flex items-baseline gap-[2.5vw] border-b border-line pb-[2.4vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[4vw] shrink-0">02</div>
            <div className="text-[2vw] font-bold w-[15vw] shrink-0 tracking-[-0.02em]">
              Metrics
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              Search Console impressions and clicks, plus direct-traffic sessions
            </div>
          </div>
          <div className="flex items-baseline gap-[2.5vw] pb-[0.5vh]">
            <div className="text-[1.5vw] font-thin text-accent w-[4vw] shrink-0">03</div>
            <div className="text-[2vw] font-bold w-[15vw] shrink-0 tracking-[-0.02em]">
              Window
            </div>
            <div className="text-[1.8vw] text-muted leading-[1.45]">
              Monthly data, April 2025 – June 2026, using average month-over-month growth
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.4vw] text-label max-w-[60vw] leading-[1.5]">
            April 2025 excluded as a data anomaly. Search Console coverage begins
            April 20, 2025, so the earliest rounds are not fully captured.
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">02</div>
        </div>
      </div>
    </div>
  );
}
