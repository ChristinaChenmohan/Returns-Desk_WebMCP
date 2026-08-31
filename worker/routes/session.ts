import { z } from "zod";
import { ResetService } from "../demo/reset-service";
import { issueCsrfToken } from "../http/csrf";
import { issueChannelToken } from "../http/channel-token";
import { command, human, keySchema, type RouteKit } from "./shared";
export function sessionRoutes(k: RouteKit, signingKey: string) {
  k.write("post", "/session/reset", "demo.reset.human", async c => {
    const input = command(c, z.object({ confirmation: z.literal("reset_current_demo_session"), idempotencyKey: keySchema }).strict());
    const context = human(c);
    const reset = await new ResetService(k.db, k.clock, k.ids).reset({ sessionId: context.sessionId, expectedSeedVersion: context.seedVersion, idempotencyKey: input.idempotencyKey });
    const tokenInput = { signingKey, sessionId: context.sessionId, seedVersion: reset.seedVersion, now: k.clock.now() };
    c.set("requestContext", { ...context, seedVersion: reset.seedVersion });
    return k.ok(c, { seedVersion: reset.seedVersion, resetCount: reset.resetCount, csrfToken: await issueCsrfToken(tokenInput), humanChannelToken: await issueChannelToken({ ...tokenInput, channel: "human" }) });
  });
}
