export default function DirectTraffic() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[42vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            04 — Direct Traffic
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            A separate path
          </h2>
        </div>

        <div className="flex-1 flex items-center gap-[4vw] py-[2vh]">
          <div className="w-[37vw] shrink-0">
            <div className="text-[1.5vw] uppercase tracking-[0.16em] text-label mb-[2vh]">
              Direct growth / month
            </div>
            <div className="flex items-baseline gap-[1.5vw] border-b border-line pb-[2vh] mb-[2vh]">
              <div className="text-[6vw] font-extrabold leading-none tracking-[-0.03em]">
                +14%
              </div>
              <div className="text-[1.7vw] text-muted">Partnership months</div>
            </div>
            <div className="flex items-baseline gap-[1.5vw]">
              <div className="text-[6vw] font-extrabold leading-none tracking-[-0.03em] text-muted">
                +22%
              </div>
              <div className="text-[1.7vw] text-muted">Control months</div>
            </div>
            <div className="text-[1.6vw] text-text font-medium mt-[3vh] leading-[1.4] [text-wrap:pretty]">
              Direct visits grew slightly slower in partnership months — no
              measurable lift.
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-[3vh]">
            <div className="border-b border-line pb-[2.6vh]">
              <div className="text-[1.9vw] font-bold tracking-[-0.02em] mb-[1vh]">
                Rise together over 14 months
              </div>
              <div className="flex items-baseline gap-[1.4vw]">
                <div className="text-[3vw] font-extrabold text-accent leading-none">
                  r = 0.86
                </div>
                <div className="text-[1.5vw] text-muted leading-[1.4]">
                  Impressions and direct both trend up over time
                </div>
              </div>
            </div>
            <div className="border-b border-line pb-[2.6vh]">
              <div className="text-[1.9vw] font-bold tracking-[-0.02em] mb-[1vh]">
                Move together month-to-month?
              </div>
              <div className="flex items-baseline gap-[1.4vw]">
                <div className="text-[3vw] font-extrabold text-text leading-none">
                  r = −0.05
                </div>
                <div className="text-[1.5vw] text-muted leading-[1.4]">
                  No monthly co-movement — the trend, not the rounds
                </div>
              </div>
            </div>
            <div>
              <div className="text-[1.9vw] font-bold tracking-[-0.02em] mb-[1vh]">
                Biggest spikes were control months
              </div>
              <div className="text-[1.6vw] text-muted leading-[1.45]">
                October (+98%) and December 2025 (+128%) — both without a
                partnership round
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end items-end">
          <div className="text-[6vw] font-thin text-num leading-none">04</div>
        </div>
      </div>
    </div>
  );
}
