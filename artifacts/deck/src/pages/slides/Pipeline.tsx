export default function Pipeline() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[25vw] w-px h-screen bg-line-faint" />
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line-faint" />
      <div className="absolute top-0 left-[75vw] w-px h-screen bg-line-faint" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            05 — Data Pipeline
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            From crawl to suggestion
          </h2>
        </div>

        <div className="relative mb-[2vh]">
          <div className="absolute top-[3.5vw] left-[3.5vw] right-[3.5vw] h-[0.25vw] bg-accent" />
          <div className="relative flex justify-between">
            <div className="w-[20vw]">
              <div className="w-[7vw] h-[7vw] bg-accent flex items-center justify-center text-bg text-[3.4vw] font-light mb-[2.5vh]">
                1
              </div>
              <h3 className="text-[2vw] font-bold tracking-[-0.02em]">Crawl</h3>
              <p className="text-[1.8vw] text-muted leading-[1.45] mt-[1vh]">
                Pull WordPress content and existing internal links
              </p>
            </div>
            <div className="w-[20vw]">
              <div className="w-[7vw] h-[7vw] bg-accent flex items-center justify-center text-bg text-[3.4vw] font-light mb-[2.5vh]">
                2
              </div>
              <h3 className="text-[2vw] font-bold tracking-[-0.02em]">Embed</h3>
              <p className="text-[1.8vw] text-muted leading-[1.45] mt-[1vh]">
                Vectorize pages and assign authority tiers 1–4
              </p>
            </div>
            <div className="w-[20vw]">
              <div className="w-[7vw] h-[7vw] bg-accent flex items-center justify-center text-bg text-[3.4vw] font-light mb-[2.5vh]">
                3
              </div>
              <h3 className="text-[2vw] font-bold tracking-[-0.02em]">Ingest</h3>
              <p className="text-[1.8vw] text-muted leading-[1.45] mt-[1vh]">
                Layer in Search Console performance and losers
              </p>
            </div>
            <div className="w-[20vw]">
              <div className="w-[7vw] h-[7vw] bg-accent flex items-center justify-center text-bg text-[3.4vw] font-light mb-[2.5vh]">
                4
              </div>
              <h3 className="text-[2vw] font-bold tracking-[-0.02em]">Suggest</h3>
              <p className="text-[1.8vw] text-muted leading-[1.45] mt-[1vh]">
                Score candidate links and write ranked suggestions
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows Internal Linking
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">05</div>
        </div>
      </div>
    </div>
  );
}
