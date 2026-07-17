export default function Conclusion() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line-faint" />
      <div className="absolute bottom-[5vh] left-[5vw] w-[6vw] h-[6vw] bg-accent" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            06 — What It Means
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            The takeaway
          </h2>
        </div>

        <div className="flex-1 flex flex-col justify-center gap-[3vh] py-[2vh] pl-[10vw]">
          <div className="flex items-baseline gap-[2vw] border-b border-line pb-[2.6vh]">
            <div className="text-[2vw] font-thin text-accent w-[3vw] shrink-0">01</div>
            <div>
              <div className="text-[2.4vw] font-bold tracking-[-0.02em] mb-[0.8vh]">
                Partnerships moved search visibility
              </div>
              <div className="text-[1.7vw] text-muted leading-[1.45]">
                Impressions grew about 3× faster and clicks about 2.2× faster in
                partnership months.
              </div>
            </div>
          </div>
          <div className="flex items-baseline gap-[2vw] border-b border-line pb-[2.6vh]">
            <div className="text-[2vw] font-thin text-accent w-[3vw] shrink-0">02</div>
            <div>
              <div className="text-[2.4vw] font-bold tracking-[-0.02em] mb-[0.8vh]">
                Direct traffic followed its own path
              </div>
              <div className="text-[1.7vw] text-muted leading-[1.45]">
                No measurable partnership lift; its largest spikes landed in
                control months.
              </div>
            </div>
          </div>
          <div className="flex items-baseline gap-[2vw]">
            <div className="text-[2vw] font-thin text-accent w-[3vw] shrink-0">03</div>
            <div>
              <div className="text-[2.4vw] font-bold tracking-[-0.02em] mb-[0.8vh]">
                Value shows up in search exposure
              </div>
              <div className="text-[1.7vw] text-muted leading-[1.45]">
                Track future rounds at the target-URL level to isolate their
                impact.
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.4vw] text-label max-w-[56vw] leading-[1.5] pl-[8vw]">
            Correlation, not a controlled experiment. Search Console data begins
            April 20, 2025; April 2025 excluded as an anomaly.
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">06</div>
        </div>
      </div>
    </div>
  );
}
