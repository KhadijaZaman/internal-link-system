export default function Title() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line" />
      <div className="absolute top-0 left-[25vw] w-px h-screen bg-line-faint" />
      <div className="absolute top-0 left-[75vw] w-px h-screen bg-line-faint" />
      <div className="absolute left-0 top-[50vh] w-screen h-px bg-line-faint" />

      <div className="absolute top-[5vh] left-[5vw] w-[6vw] h-[6vw] bg-accent" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="flex justify-between items-start mt-[13vh]">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.22em] text-label">
            Internal SEO Operations
          </div>
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Overview / 2026
          </div>
        </div>

        <div>
          <h1 className="text-[8vw] font-extrabold leading-[0.9] tracking-[-0.045em] text-text">
            Wellows
          </h1>
          <h1 className="text-[8vw] font-light leading-[0.9] tracking-[-0.045em] text-text">
            Internal Linking
          </h1>
        </div>

        <div className="flex justify-between items-end">
          <p className="text-[2vw] text-muted max-w-[44vw] leading-[1.55]">
            An internal dashboard that turns Search Console data and a full site
            crawl into ranked, AI-assisted internal-link suggestions.
          </p>
          <div className="text-[6vw] font-thin text-num leading-none">01</div>
        </div>
      </div>
    </div>
  );
}
