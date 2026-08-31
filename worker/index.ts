import type { Env } from "./env";
import { createApp } from "./app";
import { SessionRepository } from "./repositories/session-repository";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = createApp({
      db: env.DB,
      sessionRepository: new SessionRepository(env.DB),
      channelSigningKey: env.CHANNEL_SIGNING_KEY,
      allowedOrigin: new URL(request.url).origin,
      assets: env.ASSETS,
      logSink: entry => console.log(JSON.stringify(entry)),
    });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
