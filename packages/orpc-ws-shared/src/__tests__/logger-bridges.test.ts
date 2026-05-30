import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  consoleLogger,
  fromNestShape,
  fromPinoShape,
} from "../logger.js";

describe("consoleLogger", () => {
  // Restore the global console after each spy run so the test runner's own
  // logging isn't muted by leftover stubs.
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prepends [prefix] when configured and forwards meta", () => {
    const log = consoleLogger("orpc-ws");
    log.info("hello", { x: 1 });
    expect(infoSpy).toHaveBeenCalledWith("[orpc-ws] hello", { x: 1 });
  });

  it("emits the raw msg when no prefix is given", () => {
    const log = consoleLogger();
    log.info("hello", { x: 1 });
    expect(infoSpy).toHaveBeenCalledWith("hello", { x: 1 });
  });

  it("passes empty string as second arg when meta is absent", () => {
    // Why empty string and not undefined: `console.debug("msg", undefined)`
    // renders the literal word "undefined" in many terminals/devtools.
    const log = consoleLogger();
    log.debug("d");
    log.warn("w");
    log.error("e");
    expect(debugSpy).toHaveBeenCalledWith("d", "");
    expect(warnSpy).toHaveBeenCalledWith("w", "");
    expect(errorSpy).toHaveBeenCalledWith("e", "");
  });
});

describe("fromPinoShape", () => {
  const makeMock = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  it("swaps to (meta, msg) order when meta is present", () => {
    const pino = makeMock();
    const log = fromPinoShape(pino);
    log.info("hello", { x: 1 });
    expect(pino.info).toHaveBeenCalledWith({ x: 1 }, "hello");
  });

  it("forwards just (msg) when meta is absent", () => {
    const pino = makeMock();
    const log = fromPinoShape(pino);
    log.info("hello");
    expect(pino.info).toHaveBeenCalledWith("hello");
    expect(pino.info).toHaveBeenCalledTimes(1);
  });

  it("applies the same swap to debug/warn/error", () => {
    const pino = makeMock();
    const log = fromPinoShape(pino);
    log.debug("d", { a: 1 });
    log.warn("w", { b: 2 });
    log.error("e", { c: 3 });
    expect(pino.debug).toHaveBeenCalledWith({ a: 1 }, "d");
    expect(pino.warn).toHaveBeenCalledWith({ b: 2 }, "w");
    expect(pino.error).toHaveBeenCalledWith({ c: 3 }, "e");
  });
});

describe("fromNestShape", () => {
  const makeMock = () => ({
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  it("merges meta into { msg, ...meta } and routes info → log", () => {
    const nest = makeMock();
    const log = fromNestShape(nest);
    log.info("hello", { x: 1 });
    // The crucial assertion: Nest has no `info` method, so the bridge must
    // hit `log` instead. Catching a future regression where someone copies
    // the Pino bridge wholesale.
    expect(nest.log).toHaveBeenCalledWith({ msg: "hello", x: 1 });
  });

  it("passes the raw msg through when meta is absent", () => {
    const nest = makeMock();
    const log = fromNestShape(nest);
    log.info("hello");
    expect(nest.log).toHaveBeenCalledWith("hello");
  });

  it("routes debug/warn/error to their Nest counterparts with merged meta", () => {
    const nest = makeMock();
    const log = fromNestShape(nest);
    log.debug("d", { a: 1 });
    log.warn("w", { b: 2 });
    log.error("e", { c: 3 });
    expect(nest.debug).toHaveBeenCalledWith({ msg: "d", a: 1 });
    expect(nest.warn).toHaveBeenCalledWith({ msg: "w", b: 2 });
    expect(nest.error).toHaveBeenCalledWith({ msg: "e", c: 3 });
  });
});
