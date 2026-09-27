import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// NOTE: StrictMode is deliberately NOT used here. Its development-mode double
// effect invocation would open two backend WebSockets and start the microphone
// twice for the same session, which produces duplicated audio chunks and a
// connection that immediately replaces itself.
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
