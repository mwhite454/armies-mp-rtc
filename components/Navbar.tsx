import type { UserState } from "../utils.ts";

interface NavbarProps {
  user: UserState | null;
}

export function Navbar({ user }: NavbarProps) {
  return (
    <div class="navbar bg-base-200 border-b border-base-300 px-4">
      <div class="navbar-start">
        <a href="/" class="text-primary font-bold text-lg tracking-widest">
          ⚔️ TACTICAL GRID
        </a>
      </div>
      <div class="navbar-end gap-2">
        {user
          ? (
            <>
              <a href="/lobby" class="btn btn-sm btn-primary">Play</a>
              <div class="dropdown dropdown-end">
                <div
                  tabIndex={0}
                  role="button"
                  class="btn btn-ghost btn-circle avatar"
                >
                  <div class="w-8 rounded-full">
                    <img
                      src={user.avatarUrl}
                      alt={user.name}
                      referrerpolicy="no-referrer"
                    />
                  </div>
                </div>
                <ul
                  tabIndex={0}
                  class="mt-3 z-[1] p-2 shadow menu menu-sm dropdown-content bg-base-200 rounded-box w-36"
                >
                  <li class="menu-title text-xs opacity-60">{user.name}</li>
                  <li>
                    <a href="/logout" class="text-error">Sign out</a>
                  </li>
                </ul>
              </div>
            </>
          )
          : (
            <a href="/login" class="btn btn-sm btn-primary">
              Sign in with Google
            </a>
          )}
      </div>
    </div>
  );
}
