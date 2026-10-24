// Lowercase alias for the dist/botOnly.js launcher shim — some hosts'
// startup-file fields end up with different casing, and Linux is
// case-sensitive. This forwards to the same bootstrap as botOnly.js.
require("./botOnly.js");
