export default function Architecture() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute top-[5vh] right-[5vw] w-[2.2vw] h-[2.2vw] bg-accent" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            04 — Architecture
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            One typed monorepo
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-x-[6vw] gap-y-[4.5vh] mb-[2vh]">
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
              Frontend
            </div>
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              React · wouter · shadcn/ui
            </div>
          </div>
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
              API
            </div>
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              Express 5 · OpenAPI · Zod
            </div>
          </div>
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
              Data
            </div>
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              PostgreSQL · Drizzle ORM
            </div>
          </div>
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
              Runtime
            </div>
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              pnpm · Node 24 · TypeScript 5.9
            </div>
          </div>
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
              AI
            </div>
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              text-embedding-3-small · Claude
            </div>
          </div>
          <div>
            <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-label mb-[1vh]">
              External data
            </div>
            <div className="text-[2vw] font-bold tracking-[-0.02em]">
              Search Console · DataForSEO · CrUX
            </div>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows Internal Linking
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">04</div>
        </div>
      </div>
    </div>
  );
}
