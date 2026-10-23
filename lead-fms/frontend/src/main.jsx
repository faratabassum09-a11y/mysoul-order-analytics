import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { NetworkProvider } from "./context/NetworkContext.jsx";
import NetworkBanner from "./components/NetworkBanner.jsx";
import RouteBoundary from "./components/RouteBoundary.jsx";
import "./index.css";
import "./loaders.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <NetworkProvider>
          <ToastProvider>
            <AuthProvider>
              <RouteBoundary fullscreen>
                <App />
              </RouteBoundary>
            </AuthProvider>
          </ToastProvider>
          <NetworkBanner />
        </NetworkProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// Offline support: the service worker keeps the app shell cached so a
// reload with no internet still opens the app (and shows the offline
// screen) instead of the browser's dinosaur page. Production only.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
