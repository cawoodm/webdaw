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

/** Draw dB-per-bin values (linear bins, log-scaled x) as a polyline. */
export function drawDbBins(canvas: HTMLCanvasElement, values: ArrayLike<number>): void {
  const ctx = canvas.getContext('2d')!;
  const minDb = -100;
  const maxDb = 0;
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
}

/**
 * The "Live" checkbox spectrum-style plugin UIs share: checked shows the
 * playing signal, unchecked the source's static average energy per frequency.
 */
export function liveToggle(get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const label = document.createElement('label');
  label.className = 'viz-live';
  label.title = "Checked: show the playing signal live. Unchecked: show the source's average energy per frequency.";
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = get();
  cb.onchange = (): void => set(cb.checked);
  label.append(cb, 'Live');
  return label;
}
