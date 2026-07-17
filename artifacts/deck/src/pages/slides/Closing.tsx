export default function Closing() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line-faint" />
      <div className="absolute left-0 top-[33vh] w-screen h-px bg-line-faint" />
      <div className="absolute left-0 top-[67vh] w-screen h-px bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="flex justify-between items-start mt-[2vh]">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.22em] text-label">
            In Production
          </div>
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows / 2026
          </div>
        </div>

        <div className="text-center">
          <div className="w-[3vw] h-[3vw] bg-accent mx-auto mb-[3vh]" />
          <h1 className="text-[7vw] font-extrabold leading-[0.9] tracking-[-0.045em]">
            Links that earn
          </h1>
          <h1 className="text-[7vw] font-light leading-[0.9] tracking-[-0.045em]">
            their place
          </h1>
          <p className="text-[2vw] text-muted max-w-[50vw] mx-auto leading-[1.55] mt-[4vh]">
            Deployed and running on a weekly automated cadence — crawl, classify,
            suggest, audit.
          </p>
        </div>

        <div className="flex justify-between items-end">
          <div className="flex gap-[5vw]">
            <div>
              <div className="text-[1.8vw] font-bold tracking-[-0.02em]">Deployed</div>
              <div className="text-[1.5vw] uppercase tracking-[0.16em] text-label mt-[0.5vh]">
                In production
              </div>
            </div>
            <div>
              <div className="text-[1.8vw] font-bold tracking-[-0.02em]">Weekly</div>
              <div className="text-[1.5vw] uppercase tracking-[0.16em] text-label mt-[0.5vh]">
                Automated cadence
              </div>
            </div>
            <div>
              <div className="text-[1.8vw] font-bold tracking-[-0.02em]">
                Single-admin
              </div>
              <div className="text-[1.5vw] uppercase tracking-[0.16em] text-label mt-[0.5vh]">
                Access control
              </div>
            </div>
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">10</div>
        </div>
      </div>
    </div>
  );
}
