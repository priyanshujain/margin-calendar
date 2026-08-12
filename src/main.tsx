import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { trackSafeArea } from "./safeArea";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/app.css";

// Before the first render, so the bars are the right height on the first paint rather than after.
trackSafeArea();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
