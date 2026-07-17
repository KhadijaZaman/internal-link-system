export default function HomepageDonor() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[55vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            08 — Recent Work
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            Homepage donor restriction
          </h2>
        </div>

        <div className="flex items-center justify-between gap-[5vw] mb-[2vh]">
          <div className="w-[48vw]">
            <div className="mb-[3.5vh]">
              <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
                Problem
              </div>
              <p className="text-[1.8vw] text-muted leading-[1.5]">
                The engine could turn the homepage into a donor linking out to
                many unrelated blog posts.
              </p>
            </div>
            <div>
              <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[1vh]">
                Fix
              </div>
              <p className="text-[1.8vw] text-text leading-[1.5]">
                The homepage may now link only to core money pages, capped per
                run.
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end shrink-0">
            <div className="text-[16vw] font-extrabold text-accent leading-[0.8] tracking-[-0.05em]">
              3
            </div>
            <div className="text-[1.5vw] text-muted uppercase tracking-[0.16em] text-right max-w-[20vw] mt-[1vh]">
              max homepage suggestions per run
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] text-text max-w-[60vw] leading-[1.45]">
            Applied across every donor path: semantic forward, semantic reverse,
            structural dead-end, and orphan.
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">08</div>
        </div>
      </div>
    </div>
  );
}
