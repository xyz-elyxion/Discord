// Package selfscope pins Sentinel to protecting only itself.
//
// Sentinel now serves exactly one site identity — its own, “self” — and the
// public surfaces that belong to it: the admin dashboard, the protected
// playground behind /protected/, and its own /sdk.js. Site registration for
// third-party origins is refused: Sentinel is no longer an anti-bot SaaS for
// other people's sites; it guards itself.
package selfscope

// SiteKey is the one site identity Sentinel protects: itself.
const SiteKey = "self"

// Hostname is the default hostname binding for the self site. Operators can
// tighten this via SENTINEL_SELF_HOSTNAME; dashboard stays on localhost.
const DefaultHostname = "127.0.0.1"

// DefaultPolicyName is the route policy applied to the self site.
const DefaultPolicyName = "default"
