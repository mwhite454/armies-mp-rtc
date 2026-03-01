import { signOut } from "@deno/kv-oauth";

export const handler = {
  async GET(req: Request): Promise<Response> {
    return await signOut(req);
  },
};
