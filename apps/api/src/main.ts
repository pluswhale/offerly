import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { AllExceptionsFilter } from "./common/all-exceptions.filter.js";
import { LoggingInterceptor } from "./common/logging.interceptor.js";
import { env } from "./common/env.js";

async function bootstrap(): Promise<void> {
  // rawBody: Stripe webhook signature verification needs the exact payload.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Versioned prefix per plan.md §3; /health stays unprefixed for uptime checks.
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });

  app.enableCors({ origin: env("WEB_URL", "http://localhost:3000") });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
