// Trivial liveness endpoint for container readiness gating. Any orchestrator
// (or a curious developer) can poll `GET /health/live` to know the Nest
// process has booted and is accepting HTTP.
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}
