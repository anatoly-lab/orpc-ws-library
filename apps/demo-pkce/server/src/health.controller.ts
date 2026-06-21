// Trivial liveness endpoint for container readiness gating. The e2e
// harness (and any orchestrator) polls `GET /health/live` to know the
// Nest process has booted and is accepting HTTP — it does NOT assert
// the IdP is reachable (discovery is fetched lazily on first verify),
// so the server can report "live" before Keycloak is up.
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}
