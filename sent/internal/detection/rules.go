package detection

import (
	rand "crypto/rand"
	"encoding/hex"
)

// --- signal bundle ---------------------------------------------------------
//
// Rules need shared mutable counters (requests seen, challenges failed...).
// To keep rule evaluation synchronous and pure, the *caller* (middleware)
// maintains counters and updates the RequestContext snapshot it hands to
// Evaluate. The counters themselves live in ratelimit.Limiter / storage.

// newID returns a random hex id; used for correlation in events.
func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// CounterSnapshot is the per-client stat view rules consume.
type CounterSnapshot struct {
	// RequestsPerMinute is the rolling request count kept by the limiter.
	RequestsPerMinute float64
	// ChallengeFailuresRecent is failures within the recent window.
	ChallengeFailuresRecent int
	// TokenReplaysRecent counts attempts to reuse consumed tokens.
	TokenReplaysRecent int
	// IdenticalSubmissionCount counts byte-identical (redacted) submissions
	// from this client within the dedupe window.
	IdenticalSubmissionCount int
	// Burst indicates the limiter flagged a burst pattern this request.
	Burst bool
}

// RequestContext is what rules actually see.
type RequestContext struct {
	Request
	Counters CounterSnapshot
	// RoutePolicy carries per-route expectations (e.g. required headers).
	RoutePolicy RouteExpectations
}

// RouteExpectations describe per-route configuration a rule can consult.
type RouteExpectations struct {
	// RequiredHeaders must be present with non-empty values (names lowercase).
	RequiredHeaders []string
}

// WithSnapshot builds a context for rule evaluation.
func WithSnapshot(req Request, snap CounterSnapshot, re RouteExpectations) RequestContext {
	return RequestContext{Request: req, Counters: snap, RoutePolicy: re}
}

// --- rules -----------------------------------------------------------------

// BurstRule flags sustained high request rates. Weight is proportional so
// seconds-long spikes contribute less than sustained floods.
type BurstRule struct {
	// Threshold requests/minute above which the rule fires.
	Threshold float64
	// MaxWeight scales the score at extreme rates.
	MaxWeight float64
	// Action recommended once the threshold is crossed.
	Action Action
	// Severity reported.
	Severity Severity
}

func (r BurstRule) Name() string { return "burst_requests" }

func (r BurstRule) Evaluate(rc RequestContext) Contribution {
	if !rc.Counters.Burst && rc.Counters.RequestsPerMinute < r.Threshold {
		return Contribution{}
	}
	over := rc.Counters.RequestsPerMinute - r.Threshold
	if over < 0 {
		over = 0
	}
	weight := r.MaxWeight * (over / (r.Threshold + 1))
	if weight > r.MaxWeight {
		weight = r.MaxWeight
	}
	if weight < 5 {
		weight = 5
	}
	return Contribution{Weight: weight, Action: r.Action, Severity: r.Severity, Reason: "request rate above threshold"}
}

// ChallengeFailureRule penalizes clients repeatedly failing challenges
// (replay attempts, wrong nonces, forged payloads).
type ChallengeFailureRule struct {
	Threshold int
	Weight    float64
	Action    Action
	Severity  Severity
}

func (r ChallengeFailureRule) Name() string { return "challenge_failures" }

func (r ChallengeFailureRule) Evaluate(rc RequestContext) Contribution {
	n := rc.Counters.ChallengeFailuresRecent
	if n < r.Threshold {
		return Contribution{}
	}
	return Contribution{Weight: r.Weight, Action: r.Action, Severity: r.Severity, Reason: "repeated failed challenges"}
}

// TokenReplayRule fires on attempts to reuse consumed verification tokens —
// a strong automation signal because browsers never re-send tokens.
type TokenReplayRule struct {
	Threshold int
	Weight    float64
	Action    Action
	Severity  Severity
}

func (r TokenReplayRule) Name() string { return "token_replay" }

func (r TokenReplayRule) Evaluate(rc RequestContext) Contribution {
	n := rc.Counters.TokenReplaysRecent
	if n < r.Threshold {
		return Contribution{}
	}
	return Contribution{Weight: r.Weight, Action: r.Action, Severity: r.Severity, Reason: "verification token reuse"}
}

// IdenticalSubmissionRule flags the same (redacted) payload submitted many
// times — typical of third-party spambots replaying a captured form.
type IdenticalSubmissionRule struct {
	Threshold int
	Weight    float64
	Action    Action
	Severity  Severity
}

func (r IdenticalSubmissionRule) Name() string { return "repeated_submissions" }

func (r IdenticalSubmissionRule) Evaluate(rc RequestContext) Contribution {
	n := rc.Counters.IdenticalSubmissionCount
	if n < r.Threshold {
		return Contribution{}
	}
	return Contribution{Weight: r.Weight, Action: r.Action, Severity: r.Severity, Reason: "duplicate submission fingerprint"}
}

// HeaderAnomalyRule checks presence of expected headers and absence of a
// suspicious gap. Presence-only checks avoid assuming a specific fingerprint.
type HeaderAnomalyRule struct {
	Weight   float64
	Action   Action
	Severity Severity
	// DefaultRequired applies when a route declares no expectations.
	DefaultRequired []string
}

func (r HeaderAnomalyRule) Name() string { return "header_anomaly" }

func (r HeaderAnomalyRule) Evaluate(rc RequestContext) Contribution {
	required := rc.RoutePolicy.RequiredHeaders
	if len(required) == 0 {
		required = r.DefaultRequired
	}
	missing := 0
	for _, h := range required {
		if _, ok := rc.Headers[h]; !ok {
			missing++
		}
	}
	if missing == 0 {
		return Contribution{}
	}
	return Contribution{
		Weight:   r.Weight * float64(missing),
		Action:   r.Action,
		Severity: r.Severity,
		Reason:   "missing expected headers",
	}
}

// UnverifiedPenalty adds a small fixed penalty to unverified traffic. It
// alone never blocks anyone; it just makes the score sensitive to whether a
// challenge was completed when policy demands verification.
type UnverifiedPenalty struct {
	Weight   float64
	Action   Action
	Severity Severity
	// OnlyForActions constrains the penalty to listed protected actions;
	// empty means all.
	OnlyForActions []string
}

func (r UnverifiedPenalty) Name() string { return "unverified_traffic" }

func (r UnverifiedPenalty) Evaluate(rc RequestContext) Contribution {
	if rc.Verified || len(r.OnlyForActions) == 0 {
		if rc.Verified {
			return Contribution{}
		}
	}
	if len(r.OnlyForActions) > 0 && !containsAction(r.OnlyForActions, rc.Action) {
		return Contribution{}
	}
	return Contribution{Weight: r.Weight, Action: r.Action, Severity: r.Severity, Reason: "no verified challenge token"}
}

func containsAction(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// VerifiedBypass tracks requests that DID present a token so dashboards can
// show the challenge completion funnel.
type VerifiedRule struct{}

func (VerifiedRule) Name() string { return "verified" }

func (VerifiedRule) Evaluate(rc RequestContext) Contribution {
	if rc.Verified {
		return Contribution{}
	}
	return Contribution{}
}
