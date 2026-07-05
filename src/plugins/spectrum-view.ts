import * as Tone from 'tone';

/**
 * Draw a live FFT spectrum onto a canvas until the returned stop
 * function is called or the canvas leaves the document.
 */
export function drawSpectrum(canvas: HTMLCanvasElement, analyser: Tone.Analyser): () => void {
  const ctx = canvas.getContext('2d')!;
  let raf = 0;
  const minDb = -100;
  const maxDb = 0;

  const frame = (): void => {
    if (!canvas.isConnected) return;
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
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
