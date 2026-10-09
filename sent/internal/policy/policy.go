// Package policy turns a detection score into an enforcement decision.
//
// Structure:
//
//	Thresholds: score >= challenge → Challenge, >= throttle → Throttle,
//	            >= block → Block, else Allow. (Ordering is enforced at load.)
//	Overrides:  verified tokens bypass Challenge-threshold decisions when
//	            RequireVerified is false for the route; denylist always wins;
//	            allowlist always wins over everything else.
//	Failures:   FailOpen routes fall back to Allow when backing services are
//	            unhealthy; FailClosed routes fall back to Block. Behavior is
//	            explicit and observable (decision includes Degraded flag).
package policy

import (
	"fmt"
	"strings"
)

// Decision is the outcome of an evaluation.
type Decision string

const (
	Allow     Decision = "allow"
	Challenge Decision = "challenge"
	Throttle  Decision = "throttle"
	Block     Decision = "block"
)

// ParseDecision validates an externally supplied decision string.
func ParseDecision(s string) (Decision, error) {
	d := Decision(strings.ToLower(strings.TrimSpace(s)))
	switch d {
	case Allow, Challenge, Throttle, Block:
		return d, nil
	default:
		return "", fmt.Errorf("policy: invalid decision %q", s)
	}
}

// Thresholds maps scores to decisions. They must satisfy:
// ChallengeThreshold < ThrottleThreshold < BlockThreshold.
type Thresholds struct {
	ChallengeThreshold float64
	ThrottleThreshold  float64
	BlockThreshold     float64
}

// Validate enforces threshold ordering.
func (t Thresholds) Validate() error {
	if t.ChallengeThreshold <= 0 || t.ThrottleThreshold <= t.ChallengeThreshold || t.BlockThreshold <= t.ThrottleThreshold {
		return fmt.Errorf("policy: thresholds must be 0 < challenge < throttle < block, got %v/%v/%v",
			t.ChallengeThreshold, t.ThrottleThreshold, t.BlockThreshold)
	}
	return nil
}

// Decide returns the decision for a raw score.
func (t Thresholds) Decide(score float64, verified bool, requireVerified bool) Decision {
	if verified && !requireVerified && score < t.ThrottleThreshold {
		// A valid token earns at most an allow through the challenge band:
		// completed work is not re-challenged unless still suspicious.
		return Allow
	}
	switch {
	case score >= t.BlockThreshold:
		return Block
	case score >= t.ThrottleThreshold:
		return Throttle
	case score >= t.ChallengeThreshold:
		return Challenge
	default:
		return Allow
	}
}

// ListRule is a single allowlist/denylist entry.
type ListRule struct {
	// ClientID exact match, or empty to match only by prefix.
	ClientID string
	// CIDRPrefix is an optional IP prefix like "10.0.0.0/8".
	CIDRPrefix string
	// Comment explains why the entry exists (shown in dashboard).
	Comment string
}

// FailureMode describes behavior when backing infrastructure is unavailable.
type FailureMode string

const (
	FailOpen   FailureMode = "fail_open"   // allow traffic, log degraded decisions
	FailClosed FailureMode = "fail_closed" // block traffic, log degraded decisions
)

// RoutePolicy is the complete configuration for one protected route pattern.
type RoutePolicy struct {
	// ID is a stable identifier for events and API references.
	ID string
	// SiteKey restricts this policy to one site.
	SiteKey string
	// Hostname match (exact; empty = any host on the site).
	Hostname string
	// Method match (empty = any).
	Method string
	// PathPrefix match ("" = any).
	PathPrefix string
	// ActionName is the protected action expected for challenges/tokens.
	ActionName string
	// RequireVerified demands a valid token on every request.
	RequireVerified bool
	// ChallengeDifficulty 10..22 when challenged.
	ChallengeDifficulty int
	// Thresholds map risk score to decision.
	Thresholds Thresholds
	// RateLimit requests per window; 0 disables.
	RateLimit int
	// RateWindowSeconds window length.
	RateWindowSeconds int
	// Allowlist short-circuits to Allow.
	Allowlist []ListRule
	// Denylist short-circuits to Block.
	Denylist []ListRule
	// FailureMode for storage/cache outages.
	FailureMode FailureMode
	// Simulation evaluates and logs but never enforces.
	Simulation bool
}

// Matches reports whether this policy applies to a request description.
func (p RoutePolicy) Matches(siteKey, hostname, method, path string) bool {
	if p.SiteKey != siteKey {
		return false
	}
	if p.Hostname != "" && p.Hostname != hostname {
		return false
	}
	if p.Method != "" && p.Method != method {
		return false
	}
	if p.PathPrefix != "" && !strings.HasPrefix(path, p.PathPrefix) {
		return false
	}
	return true
}

// Evaluator resolves policy and produces decisions.
type Evaluator struct {
	// DefaultThresholds used when a policy does not override them.
	DefaultThresholds Thresholds
}

// Outcome bundles the final decision for events/metrics.
type Outcome struct {
	Decision Decision
	// Score, if a detection result contributed.
	Score float64
	// Degraded is true when the decision was taken during an outage.
	Degraded bool
	// Reason is human readable and event-safe.
	Reason string
	// PolicyID of the policy that produced this, if any.
	PolicyID string
	// Simulated decisions are logged but not enforced.
	Simulated bool
}

// Evaluate applies the policy mat to a scored request.
// helper data: allowlisted/denylisted resolved by caller matching clientID.
func (ev *Evaluator) EvaluatePol(p RoutePolicy, score float64, verified bool, allowlisted, denylisted bool, degraded, dependencyHealthy bool) Outcome {
	out := Outcome{Score: score, PolicyID: p.ID, Simulated: p.Simulation}

	if !dependencyHealthy {
		if p.FailureMode == FailClosed || p.FailureMode == "" {
			out.Decision = Block
			out.Degraded = true
			out.Reason = "dependency unavailable; fail-closed"
		} else {
			out.Decision = Allow
			out.Degraded = true
			out.Reason = "dependency unavailable; fail-open"
		}
		return out
	}
	if denylisted {
		out.Decision = Block
		out.Reason = "client is denylisted"
		return out
	}
	if allowlisted {
		out.Decision = Allow
		out.Reason = "client is allowlisted"
		return out
	}
	if p.RequireVerified && !verified {
		out.Decision = Challenge
		out.Reason = "route requires a verified challenge token"
		return out
	}
	th := p.Thresholds
	if th.ChallengeThreshold == 0 && th.BlockThreshold == 0 {
		th = ev.DefaultThresholds
	}
	out.Decision = th.Decide(score, verified, p.RequireVerified)
	out.Reason = fmt.Sprintf("score %.1f vs thresholds", score)
	return out
}

// OutcomeFromApply is a convenience for handling limiter-derived decisions
// (429-style) without invoking detection.
func OutcomeFromApply(p RoutePolicy, limited bool, healthy bool) Outcome {
	out := Outcome{PolicyID: p.ID, Simulated: p.Simulation}
	if !healthy {
		if p.FailureMode == FailClosed || p.FailureMode == "" {
			out.Decision = Block
			out.Degraded = true
			out.Reason = "dependency unavailable; fail-closed"
		} else {
			out.Decision = Allow
			out.Degraded = true
			out.Reason = "dependency unavailable; fail-open"
		}
		return out
	}
	if limited {
		out.Decision = Throttle
		out.Reason = "rate limit exceeded"
	} else {
		out.Decision = Allow
		out.Reason = "within rate limit"
	}
	return out
}
