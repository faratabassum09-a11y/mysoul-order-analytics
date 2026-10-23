import mongoose from "mongoose";

// Two roles:
// - "admin":  runs everything — Daily Board, Reports, Team, Settings, sheet import, assigning leads.
// - "caller": works their own leads only — sees the leads whose "Assigned To" matches their
//             caller name (leadName, or their account name if that is left blank).
// Enforced on the server in middleware/auth.js and routes/leads.js, not just hidden in the UI.
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["admin", "caller"], default: "caller" },
    active: { type: Boolean, default: true },
    // The name leads are assigned to ("Assigned To" in the sheet). Blank = use `name`.
    leadName: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
