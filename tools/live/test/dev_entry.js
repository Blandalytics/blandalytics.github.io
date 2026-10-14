// The Worker for `wrangler dev` (npm run dev): workerd takes every named export of the main
// module for an entrypoint and refuses the constants src/index.js exports for the tests
// (FEED_FIELDS, ...), so local runs start from this module, which exports only the handlers.
export { default } from "../src/index.js";
