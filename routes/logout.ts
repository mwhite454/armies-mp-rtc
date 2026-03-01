import { signOut } from "@deno/kv-oauth";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    return await signOut(ctx.req);
  },
});
