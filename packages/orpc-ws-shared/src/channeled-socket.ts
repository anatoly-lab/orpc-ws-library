// ChanneledSocket — the per-channel socket facade an ORPC adapter consumes.
//
// One `ChanneledSocket` represents ONE logical channel (`c2s` or `s2c`)
// over the shared underlying socket. It is a THIN VIEW: it holds no state of
// its own, delegating every operation to its `SocketMultiplexer`, which owns
// all listener registries and the single real socket. That keeps state in
// one place and makes the facade trivially substitutable.
//
// It implements `UnderlyingSocket`, which covers every member both ORPC
// adapters' `Pick<WebSocket, …>` requirements actually use at runtime (see
// `socket.ts`), so an ORPC link or handler can be pointed at a
// `ChanneledSocket` — without ever learning it shares the wire. It is NOT,
// however, structurally a `Pick<WebSocket, …>` (our `SocketEvent` /
// `addEventListener` are deliberately narrower than the DOM types), so each
// ORPC wiring site needs ONE boundary cast (`as unknown as Pick<WebSocket, …>`)
// — sound because ORPC only reads `event.data`, which we provide. See the
// `socket.ts` header for the full rationale.

import type { BidiChannel, WireFrame } from "./channel.js";
import type { SocketMultiplexer } from "./socket-multiplexer.js";
import type {
  AddEventListenerOptions,
  SocketEventType,
  SocketListener,
  UnderlyingSocket,
} from "./socket.js";

export class ChanneledSocket implements UnderlyingSocket {
  constructor(
    private readonly channel: BidiChannel,
    private readonly mux: SocketMultiplexer,
  ) {}

  /** Tag the frame for this channel (via the mux) and send on the real socket. */
  send(data: WireFrame): void {
    this.mux.sendOn(this.channel, data);
  }

  /**
   * Register a listener scoped to this channel. `'message'` lands in this
   * channel's message registry (so the other channel never sees it);
   * `'open' | 'close' | 'error'` register into the lifecycle fan-out, which
   * the mux invokes for both channels.
   */
  addEventListener(
    type: SocketEventType,
    listener: SocketListener,
    options?: AddEventListenerOptions,
  ): void {
    this.mux.addChannelListener(
      this.channel,
      type,
      listener,
      options?.once ?? false,
    );
  }

  removeEventListener(type: SocketEventType, listener: SocketListener): void {
    this.mux.removeChannelListener(this.channel, type, listener);
  }

  /** Live proxy of the real socket's readyState — both channels share it. */
  get readyState(): number {
    return this.mux.readyState;
  }

  /**
   * Shared-transport semantics: there is NO per-channel half-close. The two
   * channels ride one socket, so closing one tears down the real socket and
   * therefore BOTH channels. We delegate to the underlying `close()`, which
   * makes a genuine `close` event flow back through the lifecycle fan-out to
   * both peers — exactly the behavior an ORPC adapter expects from
   * `WebSocket.close()`. (ORPC's client pick never calls `close`; this is
   * here for the cores / consumers that may.)
   */
  close(code?: number, reason?: string): void {
    this.mux.closeUnderlying(code, reason);
  }
}
