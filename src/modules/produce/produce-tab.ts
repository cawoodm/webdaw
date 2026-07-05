export class ProduceTab extends HTMLElement {
  connectedCallback(): void {
    this.className = 'tab-panel produce-tab';
    this.innerHTML = `
      <div class="card produce-stub">
        <div class="card-head"><span class="card-title">Produce</span></div>
        <p class="hint">Coming soon: mixdown console and mastering.
        Use the Master FX button in the header for master-bus effects (EQ, spectrum, …).</p>
      </div>`;
  }
}

customElements.define('produce-tab', ProduceTab);
