import { signIn } from "@deno/kv-oauth";
import { googleOAuthConfig } from "../lib/auth.ts";

export const handler = {
  async GET(req: Request): Promise<Response> {
    return await signIn(req, googleOAuthConfig);
  },
};
