import { AppError } from "@ma/core";
import { ZodError } from "zod";
import { getContext } from "../context";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return json(
      { error: { code: "BAD_REQUEST", message: "invalid request", details: err.flatten() } },
      400,
    );
  }
  if (err instanceof AppError) {
    return json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status,
    );
  }
  getContext().logger.error({ err }, "unhandled error");
  return json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
}

export function handle(fn: (req: Request, params: Record<string, string>) => Promise<unknown>) {
  return async (
    req: Request,
    ctx: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    try {
      const params = await ctx.params;
      const result = await fn(req, params);
      return result instanceof Response ? result : json(result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function query(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}
