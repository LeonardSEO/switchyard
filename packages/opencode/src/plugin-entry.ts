// OpenCode's legacy loader evaluates every runtime export as a plugin. Keep the
// public entry point deliberately single-export so constants and helpers cannot
// make the complete plugin fail to load.
export { SwitchyardPlugin as default } from "./index.js";
