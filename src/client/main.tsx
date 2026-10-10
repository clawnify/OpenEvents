import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app";
import "./styles.css";

// Agent mode: bigger targets, nothing behind hover, for an agent driving the UI.
const params = new URLSearchParams(location.search);
if (params.has("agent") || params.get("mode") === "agent") document.documentElement.dataset.agent = "";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
