import React from "react";
import { useAuth } from "./context/AuthContext.jsx";
import Login from "./pages/Login.jsx";
import LoadingScreen from "./components/LoadingScreen.jsx";
import LeadsApp from "./leads/LeadsApp.jsx";

// Lead FMS is a single app: sign in, then straight into the workspace. Which pages and data a
// person gets (admin vs caller) is decided inside LeadsApp and, for real, by the server.
export default function App() {
  const { user, loading, slow } = useAuth();
  if (loading) return <LoadingScreen slow={slow} />;
  if (!user) return <Login />;
  return <LeadsApp />;
}
