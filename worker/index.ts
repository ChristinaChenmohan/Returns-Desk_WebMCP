import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/v1/health") {
      return Response.json({ data: { status: "ok" } });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
