import * as Tone from '../core/tone';
import type { PluginInstanceState } from '../core/model';
import { uid } from '../core/model';
import type { DawPlugin } from './api';
import { createPlugin, PLUGIN_REGISTRY } from './builtins';

/**
 * Connect a plugin chain between two nodes (bypassed entries skipped).
 * Works in any Tone context, including Tone.Offline.
 */
export function connectChain(
  states: PluginInstanceState[],
  from: Tone.ToneAudioNode,
  to: Tone.ToneAudioNode,
): DawPlugin[] {
  let prev = from;
  const plugins: DawPlugin[] = [];
  for (const st of states) {
    if (st.bypassed) continue;
    const plugin = createPlugin(st.pluginId);
    if (!plugin) continue;
    plugin.setState(st.state);
    prev.connect(plugin.input);
    prev = plugin.output;
    plugins.push(plugin);
  }
  prev.connect(to);
  return plugins;
}

/**
 * <plugin-chain> — editable insert chain UI with consistent host chrome
 * (title, bypass, remove) per plugin. Call bind() to attach audio + state.
 *
 * Lifecycle is explicit, not DOM-driven: this element may be freely
 * reparented or detached (e.g. moved between dialogs, or wiped out by a
 * parent's innerHTML reset) without affecting the live audio graph. Call
 * teardown() yourself when the chain should actually release its plugins
 * and rewire input straight to output.
 */
export class PluginChainEl extends HTMLElement {
  private inNode: Tone.ToneAudioNode | null = null;
  private outNode: Tone.ToneAudioNode | null = null;
  private states: PluginInstanceState[] = [];
  private live = new Map<string, DawPlugin>();
  private onChange: () => void = () => {};

  bind(
    inNode: Tone.ToneAudioNode,
    outNode: Tone.ToneAudioNode,
    states: PluginInstanceState[],
    onChange: () => void,
  ): void {
    this.inNode = inNode;
    this.outNode = outNode;
    this.states = states;
    this.onChange = onChange;
    this.rewire();
    this.render();
  }

  teardown(): void {
    this.inNode?.disconnect();
    for (const p of this.live.values()) {
      p.output.disconnect();
      p.dispose();
    }
    this.live.clear();
    this.inNode?.connect(this.outNode ?? Tone.getDestination());
  }

  private rewire(): void {
    if (!this.inNode || !this.outNode) return;
    this.inNode.disconnect();
    for (const p of this.live.values()) p.output.disconnect();
    // drop live instances whose state entry is gone
    const ids = new Set(this.states.map((s) => s.id));
    for (const [id, p] of this.live) {
      if (!ids.has(id)) {
        p.dispose();
        this.live.delete(id);
      }
    }
    let prev = this.inNode;
    for (const st of this.states) {
      let plugin = this.live.get(st.id);
      if (!plugin) {
        const created = createPlugin(st.pluginId);
        if (!created) continue;
        created.setState(st.state);
        this.live.set(st.id, created);
        plugin = created;
      }
      if (st.bypassed) continue;
      prev.connect(plugin.input);
      prev = plugin.output;
    }
    prev.connect(this.outNode);
  }

  private render(): void {
    this.innerHTML = '';
    this.className = 'plugin-chain';
    for (const st of this.states) {
      const plugin = this.live.get(st.id);
      if (!plugin) continue;
      const host = document.createElement('div');
      host.className = 'plugin-host' + (st.bypassed ? ' bypassed' : '');
      const header = document.createElement('div');
      header.className = 'plugin-host-header';
      header.innerHTML = `<span class="plugin-name">${plugin.meta.name}</span>`;
      const bypassBtn = document.createElement('button');
      bypassBtn.textContent = st.bypassed ? 'On' : 'Bypass';
      bypassBtn.onclick = (): void => {
        st.bypassed = !st.bypassed;
        this.rewire();
        this.render();
        this.onChange();
      };
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.onclick = (): void => {
        this.states.splice(this.states.indexOf(st), 1);
        this.rewire();
        this.render();
        this.onChange();
      };
      header.append(bypassBtn, removeBtn);
      host.appendChild(header);
      const ui = plugin.createUI();
      ui.addEventListener('plugin-state-changed', () => {
        st.state = plugin.getState();
        this.onChange();
      });
      host.appendChild(ui);
      this.appendChild(host);
    }

    const addRow = document.createElement('div');
    addRow.className = 'plugin-add-row';
    const select = document.createElement('select');
    for (const f of PLUGIN_REGISTRY) {
      const opt = document.createElement('option');
      opt.value = f.meta.id;
      opt.textContent = f.meta.name;
      select.appendChild(opt);
    }
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add plugin';
    addBtn.onclick = (): void => {
      this.states.push({ id: uid(), pluginId: select.value, state: {}, bypassed: false });
      const st = this.states[this.states.length - 1];
      const plugin = createPlugin(st.pluginId);
      if (plugin) {
        st.state = plugin.getState();
        plugin.dispose();
      }
      this.rewire();
      this.render();
      this.onChange();
    };
    addRow.append(select, addBtn);
    this.appendChild(addRow);
  }
}

customElements.define('plugin-chain', PluginChainEl);
