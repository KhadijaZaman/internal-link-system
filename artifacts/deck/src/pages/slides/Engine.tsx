export default function Engine() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[50vw] w-px h-screen bg-line" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            06 — Linking Engine
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            Two passes, one graph
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-x-[6vw] mb-[2vh]">
          <div className="border-t-2 border-accent pt-[2vh] pr-[3vw]">
            <div className="text-[2.2vw] font-bold tracking-[-0.02em] mb-[2vh]">
              Semantic
            </div>
            <p className="text-[2vw] text-muted leading-[1.5] mb-[1.6vh]">
              Cosine similarity between page embeddings finds related pages.
            </p>
            <p className="text-[2vw] text-muted leading-[1.5]">
              Forward and reverse passes, gated by tier rules and link-density
              caps.
            </p>
          </div>
          <div className="border-t-2 border-text pt-[2vh] pr-[3vw]">
            <div className="text-[2.2vw] font-bold tracking-[-0.02em] mb-[2vh]">
              Structural
            </div>
            <p className="text-[2vw] text-muted leading-[1.5] mb-[1.6vh]">
              Dead-end pass rescues pages that link out to nothing.
            </p>
            <p className="text-[2vw] text-muted leading-[1.5]">
              Orphan pass feeds links to pages that nothing points to.
            </p>
          </div>
        </div>

        <div className="border-t border-line pt-[2vh] flex items-start gap-[2vw] mb-[1vh]">
          <div className="w-[1.4vw] h-[1.4vw] bg-accent shrink-0 mt-[0.4vh]" />
          <p className="text-[1.8vw] text-text leading-[1.5] max-w-[80vw]">
            A four-tier authority system governs who links to whom, and sections
            keep core money pages separate from outer blog content.
          </p>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows Internal Linking
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">06</div>
        </div>
      </div>
    </div>
  );
}
