import { createGoogleOAuthConfig, getSessionId } from "@deno/kv-oauth";
import { getKv } from "./kv.ts";
import type { UserRecord } from "./types.ts";

export const googleOAuthConfig = createGoogleOAuthConfig({
  redirectUri: `${
    Deno.env.get("BASE_URL") ?? "http://localhost:8000"
  }/auth/callback`,
  scope: "openid email profile",
});

/** Returns the authenticated user from session, or null if not logged in. */
export async function getSessionUser(
  req: Request,
): Promise<UserRecord | null> {
  const sessionId = await getSessionId(req);
  if (!sessionId) return null;

  const kv = await getKv();
  const sessionEntry = await kv.get<{ userId: string }>([
    "sessions",
    sessionId,
  ]);
  if (!sessionEntry.value) return null;

  const userEntry = await kv.get<UserRecord>([
    "users",
    sessionEntry.value.userId,
  ]);
  return userEntry.value ?? null;
}
