import { signIn } from "@deno/kv-oauth";
import { googleOAuthConfig } from "../lib/auth.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    return await signIn(ctx.req, googleOAuthConfig);
  },
});
