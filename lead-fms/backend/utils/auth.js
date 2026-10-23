import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// A real secret must be set in production (Render env vars) — this
// fallback only exists so local dev doesn't hard-crash if you forget it,
// with a loud warning so it's never mistaken for "configured."
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
if (!process.env.JWT_SECRET) {
  console.warn("[auth] JWT_SECRET is not set — using an insecure dev fallback. Set JWT_SECRET in production.");
}
const TOKEN_EXPIRY = "30d";

export async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

export async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}
