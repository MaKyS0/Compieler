import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./monaco/setup";
import { STANDALONE } from "./runtime/mode";

// Static hosting cannot send COOP/COEP; a tiny service worker adds them (then the page reloads once).
if (STANDALONE && !window.crossOriginIsolated && "serviceWorker" in navigator && window.isSecureContext && !("AndroidBridge" in window)) {
  navigator.serviceWorker
    .register(new URL("coi-serviceworker.js", document.baseURI))
    .then((reg) => {
      if (!navigator.serviceWorker.controller) reg.addEventListener("updatefound", () => undefined);
      const reload = () => !window.crossOriginIsolated && sessionStorage.getItem("coi-reloaded") !== "1" && (sessionStorage.setItem("coi-reloaded", "1"), location.reload());
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener("controllerchange", reload);
    })
    .catch(() => undefined);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
