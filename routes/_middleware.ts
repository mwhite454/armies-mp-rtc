import { define } from "../utils.ts";
import { getSessionUser } from "../lib/auth.ts";

// Public paths that don't require auth
const PUBLIC_PATHS = ["/", "/login", "/logout", "/auth/callback"];

export default define.middleware(async (ctx) => {
  // Always try to populate ctx.state.user from session
  const user = await getSessionUser(ctx.req);
  ctx.state.user = user
    ? {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    }
    : null;

  const url = new URL(ctx.req.url);
  const isPublic = PUBLIC_PATHS.includes(url.pathname) ||
    url.pathname.startsWith("/auth/");

  // Redirect unauthenticated users away from protected routes
  if (!ctx.state.user && !isPublic) {
    const redirectUrl = new URL("/login", url.origin);
    return Response.redirect(redirectUrl.toString(), 302);
  }

  return await ctx.next();
});
