// DEV-ONLY revocation trigger — demonstrates the kick path the demo
// previously couldn't exercise (§G).
//
// In production, revocation is driven by the consumer's event bus: a
// `session.invalidated` event arrives on EACH instance and that instance calls
// `cookieBffService.revokeUser(sub)`. This demo has no event bus, so this
// route is a stand-in: `POST /auth/dev/revoke { sub }` invokes the same
// `revokeUser(sub)` the real consumer would call from its event handler. It
// deletes every session for `sub` (so future connects/refreshes fail) AND
// drops the user's live WS socket on this instance.
//
// NOT for production — a real app removes this and wires the event bus instead.

import { Body, Controller, Post } from "@nestjs/common";
import { CookieBffService } from "@orpc-ws/cookie-bff-nestjs";

interface RevokeBody {
  sub?: unknown;
}

@Controller("auth/dev")
export class DevRevokeController {
  constructor(private readonly cookieBff: CookieBffService) {}

  /**
   * Revoke every session for `sub` and kick its live socket. Demo stand-in
   * for the consumer's real `session.invalidated` event handler.
   *
   * ENFORCED non-prod: short-circuits to a disabled response when
   * `NODE_ENV === "production"`, so even if this controller is accidentally
   * shipped the trigger is inert. (A real app deletes this controller and
   * wires its event bus instead.)
   */
  @Post("revoke")
  async revoke(
    @Body() body: RevokeBody,
  ): Promise<{ ok: boolean; sub?: string; error?: string }> {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: "disabled in production" };
    }
    const sub = typeof body.sub === "string" ? body.sub : null;
    if (!sub) return { ok: false };
    await this.cookieBff.revokeUser(sub);
    return { ok: true, sub };
  }
}
