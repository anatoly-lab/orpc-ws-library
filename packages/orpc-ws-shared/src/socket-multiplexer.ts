// SocketMultiplexer — lays the two logical bidi RPC channels (`c2s`, `s2c`)
// over ONE underlying socket.
//
// Phase 2 of server→client bidirectional RPC. This is pure, socket-agnostic
// plumbing: it consumes the Phase 1 codec (`tagFrame` / `untagFrame`) and
// the structural `UnderlyingSocket` seam, with NO ORPC wiring (later phases
// hand each channel's `ChanneledSocket` to an ORPC adapter). The multiplexer
// owns ALL listener state; `ChanneledSocket` is a thin view onto it.
//
// Inbound routing: exactly ONE real `'message'` listener is attached. Each
// inbound frame is normalized, de-tagged, and dispatched to ONLY the
// matching channel's `'message'` listeners — the two channels never cross.
// Lifecycle (`open` / `close` / `error`) fans OUT to both channels, because
// both ORPC peers (the link and the handler) must observe connection
// lifecycle.

import {
  BIDI_C2S_CHANNEL,
  BIDI_S2C_CHANNEL,
  type BidiChannel,
  tagFrame,
  untagFrame,
  type WireFrame,
} from "./channel.js";
import { ChanneledSocket } from "./channeled-socket.js";
import { ListenerRegistry } from "./listener-registry.js";
import { normalizeInboundData } from "./normalize-inbound.js";
import type {
  SocketEvent,
  SocketEventType,
  SocketListener,
  UnderlyingSocket,
} from "./socket.js";

/** The per-channel listener registries, indexed by event type. */
type ChannelRegistries = Readonly<Record<SocketEventType, ListenerRegistry>>;

/** Construction options for {@link SocketMultiplexer}. */
export interface SocketMultiplexerOptions {
  /**
   * Sink for any error the multiplexer catches during dispatch. Two sources:
   *   - an inbound frame that cannot be classified — an
   *     `UnknownChannelTagError` (bad/missing channel tag) or an
   *     `UnsupportedInboundDataError` (a `Blob`/fragment the socket delivered
   *     despite `binaryType='arraybuffer'`);
   *   - a consumer listener that THREW (one channel's `'message'` listener, or
   *     a lifecycle listener on either channel) — caught per-listener so a bad
   *     listener never starves its siblings.
   * Injected rather than hardcoded so the consuming core decides the policy
   * (log, close the connection, …).
   *
   * If omitted, such an error is surfaced OUT-OF-BAND via
   * `queueMicrotask(() => { throw err })` — never swallowed. That stays
   * "fail loud" (it reaches `window.onerror` / `uncaughtException`) but only
   * AFTER the current dispatch completes, so it never starves the remaining
   * listeners and never crashes mid-dispatch (which on a node `ws`
   * EventEmitter would otherwise become an `uncaughtException` → process
   * crash). A malformed frame is still a protocol violation: it is never
   * routed to a guessed channel, just surfaced.
   *
   * OPERATIONAL WARNING — on Node, that deferred rethrow IS an
   * `uncaughtException`, which by default EXITS THE PROCESS. The
   * fail-loud default is fine in a browser (`window.onerror`, noisy but
   * not fatal) and in tests, but on a server it turns one malformed
   * frame from any client into a remote crash switch. ALWAYS pass
   * `onError` in a server-side composition — this library's own server
   * core does (see `@orpc-ws/server` `bidi/connection-bidi.ts`, which
   * routes it to the injected logger).
   */
  readonly onError?: (error: unknown) => void;
}

export class SocketMultiplexer {
  private readonly registries: ReadonlyMap<BidiChannel, ChannelRegistries>;
  private readonly facades = new Map<BidiChannel, ChanneledSocket>();
  private readonly onError: ((error: unknown) => void) | undefined;
  private disposed = false;

  constructor(
    private readonly underlying: UnderlyingSocket,
    options: SocketMultiplexerOptions = {},
  ) {
    this.onError = options.onError;

    // Force synchronous binary delivery so inbound binary frames arrive as
    // ArrayBuffer, never Blob — see `normalize-inbound.ts` for why this is
    // load-bearing for per-channel ordering. Best-effort: a socket without a
    // settable `binaryType` simply ignores the write.
    this.underlying.binaryType = "arraybuffer";

    this.registries = new Map<BidiChannel, ChannelRegistries>([
      [BIDI_C2S_CHANNEL, makeChannelRegistries()],
      [BIDI_S2C_CHANNEL, makeChannelRegistries()],
    ]);

    // Exactly ONE real listener per event type — the whole point of the mux.
    this.underlying.addEventListener("message", this.handleMessage);
    this.underlying.addEventListener("open", this.handleOpen);
    this.underlying.addEventListener("close", this.handleClose);
    this.underlying.addEventListener("error", this.handleError);
  }

  /**
   * The per-channel socket facade, memoized so repeated `channel(c)` calls
   * return the same object (its identity matters to listener bookkeeping).
   */
  channel(channel: BidiChannel): ChanneledSocket {
    let facade = this.facades.get(channel);
    if (facade === undefined) {
      facade = new ChanneledSocket(channel, this);
      this.facades.set(channel, facade);
    }
    return facade;
  }

  /**
   * Detach the single real listener of each type and drop all per-channel
   * listeners. Idempotent. Does NOT close the underlying socket — listener
   * teardown is not connection teardown; the owner decides closing.
   *
   * Ordering: remove the REAL listeners first so no inbound event can arrive
   * mid-teardown and dispatch into registries we are about to clear; then
   * clear the registries. Any dangling `ChanneledSocket` becomes inert (its
   * add/remove still work but nothing is wired to the real socket).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.underlying.removeEventListener("message", this.handleMessage);
    this.underlying.removeEventListener("open", this.handleOpen);
    this.underlying.removeEventListener("close", this.handleClose);
    this.underlying.removeEventListener("error", this.handleError);

    for (const channel of this.registries.values()) {
      for (const type of EVENT_TYPES) {
        channel[type].clear();
      }
    }
  }

  // --- Facade seam: the methods `ChanneledSocket` delegates to. Same-package
  // internal surface (the mux owns all state); not part of the public API.

  /** Tag an outbound frame for its channel and hand it to the real socket. */
  sendOn(channel: BidiChannel, data: WireFrame): void {
    this.underlying.send(tagFrame(channel, data));
  }

  addChannelListener(
    channel: BidiChannel,
    type: SocketEventType,
    listener: SocketListener,
    once: boolean,
  ): void {
    this.registriesFor(channel)[type].add(listener, once);
  }

  removeChannelListener(
    channel: BidiChannel,
    type: SocketEventType,
    listener: SocketListener,
  ): void {
    this.registriesFor(channel)[type].remove(listener);
  }

  get readyState(): number {
    return this.underlying.readyState;
  }

  closeUnderlying(code?: number, reason?: string): void {
    this.underlying.close?.(code, reason);
  }

  // --- Real-socket event handlers (arrow fields: stable identity for
  // add/removeEventListener, and `this` is bound for free).

  private readonly handleMessage = (event: SocketEvent): void => {
    let channel: BidiChannel;
    let payload: WireFrame;
    try {
      const frame = normalizeInboundData(event.data);
      ({ channel, frame: payload } = untagFrame(frame));
    } catch (error) {
      // Never dispatch a frame we could not classify — surface and stop.
      // NB: a protocol-DECODE error (bad tag / unsupported shape) is
      // conceptually distinct from a socket `'error'` lifecycle event; it is
      // not fanned out as one, just routed to the error sink.
      this.surfaceError(error);
      return;
    }
    this.registriesFor(channel).message.emit({ data: payload }, this.surfaceError);
  };

  private readonly handleOpen = (event: SocketEvent): void =>
    this.fanOutLifecycle("open", event);

  private readonly handleClose = (event: SocketEvent): void =>
    this.fanOutLifecycle("close", event);

  private readonly handleError = (event: SocketEvent): void =>
    this.fanOutLifecycle("error", event);

  // Lifecycle events belong to the CONNECTION, not a channel — both peers
  // must see open/close/error, so fan out to both channels' registries.
  private fanOutLifecycle(
    type: "open" | "close" | "error",
    event: SocketEvent,
  ): void {
    this.registriesFor(BIDI_C2S_CHANNEL)[type].emit(event, this.surfaceError);
    this.registriesFor(BIDI_S2C_CHANNEL)[type].emit(event, this.surfaceError);
  }

  private registriesFor(channel: BidiChannel): ChannelRegistries {
    // `channel` always comes from the fixed `BidiChannel` union (constructor
    // seeds both keys), so this lookup never misses in practice. The `if`
    // below is a defensive guard that keeps the type honest (narrowing away
    // `undefined`) and would only fire on an internal invariant break.
    const found = this.registries.get(channel);
    if (found === undefined) {
      throw new Error(`No registries for channel ${channel}`);
    }
    return found;
  }

  // The single error sink (arrow field: stable identity, passed by reference
  // to every `ListenerRegistry.emit` and used for decode failures). Routes a
  // caught error to the injected `onError`, or — if none — surfaces it
  // out-of-band so it never starves siblings or crashes mid-dispatch.
  private readonly surfaceError = (error: unknown): void => {
    if (this.onError !== undefined) {
      this.onError(error);
      return;
    }
    // Fail loud, but AFTER dispatch: a synchronous throw here would propagate
    // out of the real `'message'`/lifecycle listener (on node `ws` that is an
    // `uncaughtException` → process crash) and starve the remaining listeners.
    queueMicrotask(() => {
      throw error;
    });
  };
}

const EVENT_TYPES = [
  "message",
  "open",
  "close",
  "error",
] as const satisfies readonly SocketEventType[];

function makeChannelRegistries(): ChannelRegistries {
  return {
    message: new ListenerRegistry(),
    open: new ListenerRegistry(),
    close: new ListenerRegistry(),
    error: new ListenerRegistry(),
  };
}
