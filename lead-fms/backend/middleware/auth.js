import User from "../models/User.js";
import { verifyToken } from "../utils/auth.js";

// Requires "Authorization: Bearer <token>". Attaches the current user (minus passwordHash) to
// req.user. The user is re-checked against the database so a deactivated account is locked out
// quickly — but that is one Mongo round-trip per call, so it is kept in memory for a few seconds.
// Anything that changes a user calls clearAuthCache() so it takes effect straight away.
const AUTH_TTL_MS = 20_000;
const userCache = new Map(); // id -> { user, exp }
export function clearAuthCache() {
  userCache.clear();
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const payload = verifyToken(token);
    let entry = userCache.get(payload.id);
    if (!entry || entry.exp <= Date.now()) {
      const found = await User.findById(payload.id).select("-passwordHash").lean();
      entry = { user: found, exp: Date.now() + AUTH_TTL_MS };
      if (userCache.size > 500) userCache.clear();
      userCache.set(payload.id, entry);
    }
    const user = entry.user;
    if (!user || user.active === false) return res.status(401).json({ error: "Account no longer active" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired — please sign in again" });
  }
}

// Stacks after requireAuth — a real permission boundary, not just a hidden button.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admins only" });
  next();
}
