import { render } from "solid-js/web";
import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import { App } from "./App";
import "./styles.css";

document.documentElement.setAttribute("data-color-scheme", "dark");

render(() => <App />, document.getElementById("root")!);