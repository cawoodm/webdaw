import * as Tone from '../core/tone';

/**
 * rAF loop for plugin canvases. Plugin UIs live inside <plugin-chain>,
 * which detaches from the DOM without dying (FX dialog close/reopen,
 * chains created during playback before any dialog shows them) — so the
 * loop must IDLE while the canvas is off-document, not terminate. It
 * terminates only when isAlive() is false (plugin disposed) or the
 * returned stop function is called.
 */
export function startPluginCanvasLoop(canvas: HTMLCanvasElement, isAlive: () => boolean, draw: () => void): () => void {
  let raf = 0;
  const frame = (): void => {
    if (!isAlive()) return;
    if (canvas.isConnected) draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/** Draw a live FFT spectrum onto a canvas until its analyser is disposed. */
export function drawSpectrum(canvas: HTMLCanvasElement, analyser: Tone.Analyser): () => void {
  const ctx = canvas.getContext('2d')!;
  const minDb = -100;
  const maxDb = 0;
  return startPluginCanvasLoop(
    canvas,
    () => !analyser.disposed,
    () => {
      const values = analyser.getValue() as Float32Array;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      for (let i = 0; i < values.length; i++) {
        // log-scale frequency axis
        const x = (Math.log(i + 1) / Math.log(values.length)) * w;
        const norm = (values[i] - minDb) / (maxDb - minDb);
        const y = h - Math.max(0, Math.min(1, norm)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#4fd1c5';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    },
  );
}
