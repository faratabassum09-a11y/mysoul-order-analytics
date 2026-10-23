import { leadCallerName } from "./leadService.js";

// The shape the frontend receives for a signed-in person (login, /me, profile edit).
export function publicUser(user) {
  const { _id, name, email, role, createdAt } = user;
  return { id: _id, name, email, role, createdAt, leadName: leadCallerName(user) };
}
