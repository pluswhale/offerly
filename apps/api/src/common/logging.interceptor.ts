import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { Observable, tap } from "rxjs";

/** Request logging interceptor (plan §3): method, url, status, duration. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: () => {
          const status = context.switchToHttp().getResponse<{ statusCode: number }>().statusCode;
          console.log(`${req.method} ${req.url} ${status} ${Date.now() - start}ms`);
        },
        error: () => {
          console.log(`${req.method} ${req.url} ERR ${Date.now() - start}ms`);
        },
      }),
    );
  }
}
