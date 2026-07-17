export default function Security() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg font-body text-text">
      <div className="absolute top-0 left-[44vw] w-px h-screen bg-line" />
      <div className="absolute left-0 top-[28vh] w-screen h-px bg-line-faint" />

      <div className="absolute top-[5vh] left-[5vw] w-[2.2vw] h-[2.2vw] bg-accent" />

      <div className="absolute inset-0 px-[5vw] py-[5vh] flex flex-col justify-between">
        <div className="mt-[3vh]">
          <div className="text-[1.5vw] font-semibold uppercase tracking-[0.2em] text-accent mb-[2vh]">
            09 — Security Model
          </div>
          <h2 className="text-[5vw] font-extrabold leading-[0.92] tracking-[-0.04em]">
            One admin, locked down
          </h2>
        </div>

        <div className="flex-1 flex flex-col justify-center gap-[3vh] py-[2vh]">
          <div className="flex items-start gap-[2.2vw] border-b border-line pb-[2.4vh]">
            <div className="w-[1.4vw] h-[1.4vw] bg-accent shrink-0 mt-[0.6vh]" />
            <p className="text-[2vw] text-text leading-[1.4]">
              One administrator, authenticated with a signed HMAC session cookie
            </p>
          </div>
          <div className="flex items-start gap-[2.2vw] border-b border-line pb-[2.4vh]">
            <div className="w-[1.4vw] h-[1.4vw] bg-accent shrink-0 mt-[0.6vh]" />
            <p className="text-[2vw] text-text leading-[1.4]">
              requireAuth on every non-public route; only health and auth
              endpoints are open
            </p>
          </div>
          <div className="flex items-start gap-[2.2vw] border-b border-line pb-[2.4vh]">
            <div className="w-[1.4vw] h-[1.4vw] bg-accent shrink-0 mt-[0.6vh]" />
            <p className="text-[2vw] text-text leading-[1.4]">
              Secrets stay server-side, and outbound fetches are scoped
            </p>
          </div>
          <div className="flex items-start gap-[2.2vw]">
            <div className="w-[1.4vw] h-[1.4vw] bg-accent shrink-0 mt-[0.6vh]" />
            <p className="text-[2vw] text-text leading-[1.4]">
              Manual job triggers are gated to contain external API and model
              spend
            </p>
          </div>
        </div>

        <div className="flex justify-between items-end">
          <div className="text-[1.5vw] font-medium uppercase tracking-[0.18em] text-label">
            Wellows Internal Linking
          </div>
          <div className="text-[6vw] font-thin text-num leading-none">09</div>
        </div>
      </div>
    </div>
  );
}
