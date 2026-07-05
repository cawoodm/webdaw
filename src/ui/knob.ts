/**
 * <daw-knob label="Gain" min="0" max="1" step="0.01" value="0.8" unit="%">
 * Vertical-drag rotary control. Emits 'input' with `detail: number`.
 * Set attribute log="1" for logarithmic response (e.g. frequencies).
 */
export class DawKnob extends HTMLElement {
  static observedAttributes = ['value', 'label'];

  private dragging = false;
  private startY = 0;
  private startValue = 0;

  get min(): number { return Number(this.getAttribute('min') ?? 0); }
  get max(): number { return Number(this.getAttribute('max') ?? 1); }
  get step(): number { return Number(this.getAttribute('step') ?? 0.01); }
  get log(): boolean { return this.getAttribute('log') === '1'; }

  get value(): number { return Number(this.getAttribute('value') ?? this.min); }
  set value(v: number) {
    const clamped = Math.min(this.max, Math.max(this.min, v));
    const snapped = Math.round(clamped / this.step) * this.step;
    this.setAttribute('value', String(Number(snapped.toFixed(6))));
  }

  connectedCallback(): void {
    this.render();
    this.addEventListener('pointerdown', this.onDown);
    this.addEventListener('wheel', this.onWheel, { passive: false });
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.render();
  }

  private norm(): number {
    if (this.log && this.min > 0) {
      return Math.log(this.value / this.min) / Math.log(this.max / this.min);
    }
    return (this.value - this.min) / (this.max - this.min);
  }

  private fromNorm(n: number): number {
    const c = Math.min(1, Math.max(0, n));
    if (this.log && this.min > 0) {
      return this.min * Math.pow(this.max / this.min, c);
    }
    return this.min + c * (this.max - this.min);
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.startY = e.clientY;
    this.startValue = this.norm();
    this.setPointerCapture(e.pointerId);
    this.addEventListener('pointermove', this.onMove);
    this.addEventListener('pointerup', this.onUp);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dy = this.startY - e.clientY;
    this.value = this.fromNorm(this.startValue + dy / 150);
    this.dispatchEvent(new CustomEvent('input', { detail: this.value }));
  };

  private onUp = (): void => {
    this.dragging = false;
    this.removeEventListener('pointermove', this.onMove);
    this.removeEventListener('pointerup', this.onUp);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.value = this.fromNorm(this.norm() + (e.deltaY < 0 ? 0.05 : -0.05));
    this.dispatchEvent(new CustomEvent('input', { detail: this.value }));
  };

  private render(): void {
    const angle = -135 + this.norm() * 270;
    const label = this.getAttribute('label') ?? '';
    const unit = this.getAttribute('unit') ?? '';
    const display = this.value >= 100 ? this.value.toFixed(0) : this.value.toFixed(2).replace(/\.?0+$/, '');
    this.innerHTML = `
      <div class="knob-dial">
        <svg viewBox="0 0 40 40" width="40" height="40">
          <circle cx="20" cy="20" r="16" class="knob-bg"/>
          <line x1="20" y1="20" x2="20" y2="6" class="knob-needle"
                transform="rotate(${angle} 20 20)"/>
        </svg>
      </div>
      <span class="knob-label">${label}</span>
      <span class="knob-value">${display}${unit}</span>`;
  }
}

customElements.define('daw-knob', DawKnob);

/** Helper to build a knob wired to a getter/setter. */
export function knob(
  opts: { label: string; min: number; max: number; step: number; value: number; log?: boolean; unit?: string },
  onChange: (value: number) => void,
): DawKnob {
  const el = document.createElement('daw-knob') as DawKnob;
  el.setAttribute('min', String(opts.min));
  el.setAttribute('max', String(opts.max));
  el.setAttribute('step', String(opts.step));
  el.setAttribute('value', String(opts.value));
  el.setAttribute('label', opts.label);
  if (opts.unit) el.setAttribute('unit', opts.unit);
  if (opts.log) el.setAttribute('log', '1');
  el.addEventListener('input', (e) => onChange((e as CustomEvent<number>).detail));
  return el;
}
