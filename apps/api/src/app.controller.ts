import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@offerly/types";
import { Public } from "./modules/auth/public.decorator.js";

@Controller()
export class AppController {
  @Public()
  @Get("health")
  health(): HealthResponse {
    return { status: "ok" };
  }
}
