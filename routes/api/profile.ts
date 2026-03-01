import { define } from "../../utils.ts";
import { getUser } from "../../lib/kv.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.state.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await getUser(ctx.state.user.id);
    if (!user) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      wins: user.wins,
      losses: user.losses,
      elo: user.elo,
    });
  },
});
