export default function Problem() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line-faint" />
      <div className="absolute top-0 left-[60vw] w-px h-screen bg-line" />

      <div className="absolute top-[5vh] left-[5vw] w-[2.2vw] h-[2.2vw] bg-accent" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            02 — The Problem
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            Internal links drift
          </h2>
          <p className="text-[2vw] text-muted max-w-[48vw] leading-[1.55] mt-[3vh]">
            Internal links route authority and crawl budget between pages.
            Managed by hand across a large content site, the structure decays.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-[6vw] gap-y-[4vh] mb-[3vh]">
          <div className="border-t-2 border-text pt-[1.6vh]">
            <div className="text-[2vw] font-bold tracking-[-0.02em]">Orphans</div>
            <div className="text-[1.8vw] text-muted mt-[0.6vh] leading-[1.45]">
              Pages nothing links to
            </div>
          </div>
          <div className="border-t-2 border-text pt-[1.6vh]">
            <div className="text-[2vw] font-bold tracking-[-0.02em]">Dead-ends</div>
            <div className="text-[1.8vw] text-muted mt-[0.6vh] leading-[1.45]">
              Pages that link out to nothing
            </div>
          </div>
          <div className="border-t-2 border-text pt-[1.6vh]">
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              Over-linking
            </div>
            <div className="text-[1.8vw] text-muted mt-[0.6vh] leading-[1.45]">
              Posts that dilute equity with too many links
            </div>
          </div>
          <div className="border-t-2 border-accent pt-[1.6vh]">
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              Starved money pages
            </div>
            <div className="text-[1.8vw] text-muted mt-[0.6vh] leading-[1.45]">
              Key pages that never receive enough links
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows Internal Linking
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">02</div>
        </div>
      </div>
    </div>
  );
}
