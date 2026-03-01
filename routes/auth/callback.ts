import { handleCallback } from "@deno/kv-oauth";
import { googleOAuthConfig } from "../../lib/auth.ts";
import { upsertUser } from "../../lib/kv.ts";
import { getKv } from "../../lib/kv.ts";

interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export const handler = {
  async GET(req: Request): Promise<Response> {
    const { response, sessionId, tokens } = await handleCallback(
      req,
      googleOAuthConfig,
    );

    // Fetch Google user profile
    const userInfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
    );
    const userInfo: GoogleUserInfo = await userInfoRes.json();

    // Upsert user in Deno KV
    const user = await upsertUser({
      id: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name,
      avatarUrl: userInfo.picture,
    });

    // Store session → userId mapping
    const kv = await getKv();
    await kv.set(["sessions", sessionId], { userId: user.id });

    return response;
  },
};
