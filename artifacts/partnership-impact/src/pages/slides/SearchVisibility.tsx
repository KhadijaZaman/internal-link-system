export default function SearchVisibility() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 right-[26vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh] flex items-end justify-between">
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
              03 — Search Visibility
            </div>
            <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
              The lift is real
            </h2>
          </div>
          <div className="text-[1.6vw] text-muted max-w-[24vw] leading-[1.45] text-right [text-wrap:pretty]">
            Search growth ran far faster in partnership months.
          </div>
        </div>

        <div className="flex-1 flex flex-col justify-center gap-[6vh] py-[2vh]">
          <div className="flex items-center gap-[3vw]">
            <div className="w-[52vw] shrink-0">
              <div className="text-[1.9vw] font-bold tracking-[-0.02em] mb-[1.6vh]">
                Impressions / month
              </div>
              <div className="flex items-center gap-[1.5vw] mb-[1.3vh]">
                <div className="w-[10vw] text-[1.4vw] uppercase tracking-[0.14em] text-label shrink-0">
                  Partnership
                </div>
                <div className="h-[3.2vh] w-[88%] bg-accent" />
                <div className="text-[2vw] font-bold text-accent shrink-0">+131%</div>
              </div>
              <div className="flex items-center gap-[1.5vw]">
                <div className="w-[10vw] text-[1.4vw] uppercase tracking-[0.14em] text-label shrink-0">
                  Control
                </div>
                <div className="h-[3.2vh] w-[29%] bg-line" />
                <div className="text-[2vw] font-bold text-muted shrink-0">+43%</div>
              </div>
            </div>
            <div className="flex-1 flex flex-col items-end">
              <div className="text-[6vw] font-extrabold leading-none tracking-[-0.03em]">
                3.0×
              </div>
              <div className="text-[1.4vw] uppercase tracking-[0.16em] text-label mt-[1vh]">
                Faster growth
              </div>
            </div>
          </div>

          <div className="flex items-center gap-[3vw]">
            <div className="w-[52vw] shrink-0">
              <div className="text-[1.9vw] font-bold tracking-[-0.02em] mb-[1.6vh]">
                Clicks / month
              </div>
              <div className="flex items-center gap-[1.5vw] mb-[1.3vh]">
                <div className="w-[10vw] text-[1.4vw] uppercase tracking-[0.14em] text-label shrink-0">
                  Partnership
                </div>
                <div className="h-[3.2vh] w-[88%] bg-accent" />
                <div className="text-[2vw] font-bold text-accent shrink-0">+44%</div>
              </div>
              <div className="flex items-center gap-[1.5vw]">
                <div className="w-[10vw] text-[1.4vw] uppercase tracking-[0.14em] text-label shrink-0">
                  Control
                </div>
                <div className="h-[3.2vh] w-[40%] bg-line" />
                <div className="text-[2vw] font-bold text-muted shrink-0">+20%</div>
              </div>
            </div>
            <div className="flex-1 flex flex-col items-end">
              <div className="text-[6vw] font-extrabold leading-none tracking-[-0.03em]">
                2.2×
              </div>
              <div className="text-[1.4vw] uppercase tracking-[0.16em] text-label mt-[1vh]">
                Faster growth
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.4vw] text-label leading-[1.5]">
            Average month-over-month growth. Monthly impressions climbed from
            under 10K to 3.9M across the window.
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">03</div>
        </div>
      </div>
    </div>
  );
}
