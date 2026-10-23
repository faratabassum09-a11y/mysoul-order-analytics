// Creates (or resets) the first admin account. There is no public sign-up — an admin creates
// accounts on the Team page, and this script is how the very first one gets made.
//
//   ADMIN_NAME="Nitin" ADMIN_EMAIL="nitin@mysoulschool.in" ADMIN_PASSWORD="a-strong-password" npm run seed:admin
//
// Safe to re-run: if the email already exists it updates the password and makes sure it is an active admin.
import "dotenv/config";
import mongoose from "mongoose";
import User from "./models/User.js";
import { hashPassword } from "./utils/auth.js";

const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Run it like:\n  ADMIN_NAME="Your Name" ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="a-strong-password" npm run seed:admin');
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 8) { console.error("ADMIN_PASSWORD must be at least 8 characters."); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/lead_fms", { serverSelectionTimeoutMS: 10_000 });
const email = ADMIN_EMAIL.toLowerCase().trim(), passwordHash = await hashPassword(ADMIN_PASSWORD);
const ex = await User.findOne({ email });
if (ex) { Object.assign(ex, { name: ADMIN_NAME, passwordHash, role: "admin", active: true }); await ex.save(); console.log(`Updated "${email}" — now an active admin with the new password.`); }
else { await User.create({ name: ADMIN_NAME, email, passwordHash, role: "admin" }); console.log(`Created admin "${email}".`); }
await mongoose.disconnect();
