import { useEffect, useState } from "react";
import { Constellation } from "../landing/Constellation.js";

/** One screen, one button: what the app does, in three lines, and that it stays on this computer. */
export function WelcomeStep({ onStart }: { onStart: () => void }) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section className="kv-onb-welcome" aria-labelledby="onb-title">
      <div className="kv-onb-sky" aria-hidden="true">
        <Constellation sample={null} saved={null} seed="knowledge-vault-welcome" width={640} height={190} settled={settled} />
      </div>
      <h2 id="onb-title" className="kv-onb-title">Turn your documents into connected notes</h2>
      <ol className="kv-onb-how">
        <li>
          <strong>Add your sources</strong>
          <span>PDFs, Word files, web pages or plain text.</span>
        </li>
        <li>
          <strong>The AI writes the notes</strong>
          <span>One idea in each, linked to the notes it builds on or contradicts.</span>
        </li>
        <li>
          <strong>Explore and ask</strong>
          <span>Follow the links, browse the maps of your topics and chat with your vault.</span>
        </li>
      </ol>
      <p className="kv-hint">Your files and notes stay on this computer.</p>
      <div className="kv-onb-actions kv-onb-actions-end">
        <button type="button" className="kv-button kv-button-primary" onClick={onStart} autoFocus>
          Get started
        </button>
      </div>
    </section>
  );
}
