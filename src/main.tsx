import { render } from "preact";
import { App } from "./ui/App";
import "./styles.css";

render(<App />, document.getElementById("app")!);

// Service worker: registered in production only (dev caching is a footgun).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
