import React from "react";
import Tasks from "./Tasks.jsx";

// Pending FU1 / FU2 / FU3 calls of earlier leads (the leads that came in today are on Today's Tasks)
export default function FollowUps() {
  return <Tasks view="followups" />;
}
