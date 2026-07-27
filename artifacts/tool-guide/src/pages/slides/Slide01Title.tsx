export default function Slide01Title() {
  return (
    <div className="slide-root w-screen h-screen overflow-hidden relative grid-bg font-body">
      <div className="absolute top-[5vh] left-[5vw] w-[3vw] h-[3vw] bg-primary" />

      <div className="absolute top-[5vh] right-[5vw] text-right">
        <div className="text-primary text-[0.9vw] font-semibold uppercase tracking-[0.1em]">Linkweave</div>
        <div className="text-faint text-[0.8vw] uppercase tracking-[0.1em] mt-[0.5vh]">Tool Guide / 2026</div>
      </div>

      <div className="absolute bottom-[10vh] left-[10vw] max-w-[62vw]">
        <div className="text-primary text-[1.2vw] font-semibold tracking-[-0.01em] mb-[2vh]">Linkweave</div>
        <h1 className="text-text text-[7vw] font-bold leading-[1.05] tracking-[-0.03em] m-0 [text-wrap:balance]">
          The Complete Tool Guide
        </h1>
        <p className="text-muted text-[1.8vw] font-normal leading-[1.4] max-w-[50vw] mt-[2vh] mb-0 [text-wrap:pretty]">
          Section-by-section logic &amp; use cases, plus the full presenter demo script
        </p>
      </div>
    </div>
  );
}
