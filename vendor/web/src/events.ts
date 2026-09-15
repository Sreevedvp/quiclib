import type { TransportState } from "@quiclib/protocol";
/** Small observer registry shared by both adapters. Subscriptions are disposable. */
export class TransportEvents {
  protected _state: TransportState = "disconnected";
  private states = new Set<(state: TransportState) => void>();
  private datagrams = new Set<(data: Uint8Array) => void>();
  get state(): TransportState {
    return this._state;
  }
  onStateChange(callback: (state: TransportState) => void): () => void {
    this.states.add(callback);
    return () => {
      this.states.delete(callback);
    };
  }
  onDatagram(callback: (data: Uint8Array) => void): () => void {
    this.datagrams.add(callback);
    return () => {
      this.datagrams.delete(callback);
    };
  }
  protected setState(state: TransportState): void {
    if (this._state === state) return;
    this._state = state;
    for (const callback of this.states) {
      try {
        callback(state);
      } catch {
        /* Isolate observers. */
      }
    }
  }
  protected emitDatagram(data: Uint8Array): void {
    for (const callback of this.datagrams) {
      try {
        callback(data);
      } catch {
        /* Isolate observers. */
      }
    }
  }
}
