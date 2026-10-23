import express from "express";
import User from "../models/User.js";
import { hashPassword, comparePassword, signToken } from "../utils/auth.js";
import { requireAuth, clearAuthCache } from "../middleware/auth.js";
import { publicUser } from "../utils/access.js";

const router = express.Router();

// Public. There is no self-registration on purpose: an admin creates accounts (Team page).
router.post("/login", async (req, res) => {
  try {
    const email = (req.body?.email || "").toLowerCase().trim();
    const password = req.body?.password || "";
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const user = await User.findOne({ email });
    if (!user || user.active === false) return res.status(401).json({ error: "Invalid email or password" });
    if (!(await comparePassword(password, user.passwordHash))) return res.status(401).json({ error: "Invalid email or password" });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restores a session on page reload.
router.get("/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// Self-service: display name only (email, role and caller name stay admin-only).
router.put("/me", requireAuth, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name can't be empty" });
    const user = await User.findByIdAndUpdate(req.user._id, { name }, { new: true }).select("-passwordHash");
    clearAuthCache();
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Current and new password required" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    const user = await User.findById(req.user._id);
    if (!(await comparePassword(currentPassword, user.passwordHash))) return res.status(401).json({ error: "Current password is incorrect" });
    user.passwordHash = await hashPassword(newPassword);
    await user.save();
    clearAuthCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
