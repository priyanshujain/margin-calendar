import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isMacDesktop } from "./ipc";
import { trackSafeArea } from "./safeArea";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/app.css";

// Before the first render, so the bars are the right height on the first paint rather than after.
trackSafeArea();

// The header's lane for the traffic lights, which only one platform draws over it. Written here
// rather than assumed by the stylesheet, for the same reason: the first paint is the right shape.
if (isMacDesktop) document.documentElement.setAttribute("data-traffic", "");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
