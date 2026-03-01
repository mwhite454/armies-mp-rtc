import { createDefine } from "fresh";

export interface UserState {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

// Shared state passed via middleware to routes and layouts
export interface State {
  user: UserState | null;
}

export const define = createDefine<State>();
