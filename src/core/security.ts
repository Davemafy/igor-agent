import { getAuth } from "../data/auth-store";
export { checkOrigin } from "./request-origin";

export const sessionCookie = "igor_session";

export function ownerFromToken(token: string) {
  if (!/^[a-f0-9-]{36}$/.test(token)) {
    throw new Error("Invalid session.");
  }

  return getAuth().owner(token);
}
