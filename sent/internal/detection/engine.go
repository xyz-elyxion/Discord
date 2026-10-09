// Package detection holds the rule-based risk scoring engine.
//
// Every signal is computed by a Rule. Rules are pure functions of a
// RequestContext (they may consult a synchronous snapshot of shared counters
// maintained by the engine); they never perform I/O themselves so evaluation
// stays fast and deterministic for a given counter snapshot.
//
// Rules contribute:
//   - a named weight contribution to the total risk score
//   - an action recommendation (Allow / Challenge / Throttle / Block)
//
// The engine sums weights, applies per-rule overrides, and the policy layer
// maps the final score to a decision with configured thresholds.
package detection

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Action is the response a rule (or the policy engine) recommends.
type Action string

const (
	Allow     Action = "allow"
	Challenge Action = "challenge"
	Throttle  Action = "throttle"
	Block     Action = "block"
)

// Actions is the exhaustive, ordered set of enforcement outcomes.
var Actions = []Action{Allow, Challenge, Throttle, Block}

// ParseAction validates a user-supplied action string.
func ParseAction(s string) (Action, error) {
	a := Action(strings.ToLower(strings.TrimSpace(s)))
	switch a {
	case Allow, Challenge, Throttle, Block:
		return a, nil
	default:
		return "", fmt.Errorf("detection: invalid action %q", s)
	}
}

// Severity for event classification.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarn     Severity = "warn"
	SeverityHigh     Severity = "high"
	SeverityCritical Severity = "critical"
)

// Request is the minified, privacy-conscious view of an inbound HTTP request
// the engine sees. No request bodies, no full URLs with query strings.
type Request struct {
	SiteKey   string
	Hostname  string
	Method    string
	Path      string // path only, no query
	Action    string // configured protected action name ("" if unknown)
	ClientID  string // privacy-preserving client identity (hash, not raw IP)
	UserAgent string
	TokenHint string // presentation of x-sentinel-token header presence, not content
	// Verified reports whether a valid signed verification token accompanied this request.
	Verified bool
	// Headers holds a small allowlist of header names the rules may consult
	// (presence only values may be truncated).
	Headers map[string]string
}

// Rule is the plugin interface. Implementations must be safe for concurrent
// use and must not block.
type Rule interface {
	// Name is a stable identifier used in events and configuration.
	Name() string
	// Evaluate returns a contribution: weight (0 = no signal) plus optional
	// recommended action and human-readable reason (stored in events).
	Evaluate(r RequestContext) Contribution
}

// Contribution is a single rule's output.
type Contribution struct {
	// Weight added to total score. May be 0 if the rule is purely advisory.
	Weight float64
	// Action recommendation; empty means "no opinion".
	Action Action
	// Severity of the resulting event if this contribution is notable.
	Severity Severity
	// Reason is shown in the dashboard; must not contain secrets or PII.
	Reason string
}

// Engine evaluates a fixed set of rules.
type Engine struct {
	mu       sync.RWMutex
	rules    []Rule
	disabled map[string]bool
}

// New builds an Engine with the provided rules.
func New(rules ...Rule) *Engine {
	e := &Engine{rules: make([]Rule, 0, len(rules)), disabled: make(map[string]bool)}
	e.rules = append(e.rules, rules...)
	return e
}

// Register adds a rule (plugin interface).
func (e *Engine) Register(r Rule) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rules = append(e.rules, r)
}

// Disable temporarily mutes a rule by name (e.g. from policy config).
func (e *Engine) Disable(name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.disabled[name] = true
}

// Enable restores a rule.
func (e *Engine) Enable(name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.disabled, name)
}

// RuleNames lists rule identifiers.
func (e *Engine) RuleNames() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	names := make([]string, 0, len(e.rules))
	for _, r := range e.rules {
		names = append(names, r.Name())
	}
	sort.Strings(names)
	return names
}

// Result is the outcome of evaluation.
type Result struct {
	// Score is the summed risk weight.
	Score float64
	// Triggered lists fired rules in evaluation order.
	Triggered []Fired
	// Recommended is the highest-severity action any rule proposed, if any.
	Recommended  Action
	hasRecommend bool
}

// Fired records one rule's contribution for the event log.
type Fired struct {
	Rule     string
	Weight   float64
	Action   Action
	Severity Severity
	Reason   string
}

// Evaluate runs all enabled rules against the full request context.
// Never panics: a panicking rule is treated as a zero contribution (reported
// as a warn event by the caller if enabled).
func (e *Engine) Evaluate(rc RequestContext) Result {
	e.mu.RLock()
	rules := make([]Rule, len(e.rules))
	copy(rules, e.rules)
	disabled := make(map[string]bool, len(e.disabled))
	for k, v := range e.disabled {
		disabled[k] = v
	}
	e.mu.RUnlock()

	var res Result
	for _, rule := range rules {
		if disabled[rule.Name()] {
			continue
		}
		c := safeEvaluate(rule, rc)
		if c.Weight == 0 && c.Action == "" {
			continue
		}
		res.Score += c.Weight
		res.Triggered = append(res.Triggered, Fired{
			Rule:     rule.Name(),
			Weight:   c.Weight,
			Action:   c.Action,
			Severity: c.Severity,
			Reason:   c.Reason,
		})
		if c.Action != "" && !res.hasRecommend {
			res.Recommended = c.Action
			res.hasRecommend = true
		}
	}
	return res
}

func safeEvaluate(rule Rule, rc RequestContext) (c Contribution) {
	defer func() {
		if p := recover(); p != nil {
			c = Contribution{Severity: SeverityWarn, Reason: "rule panicked"}
		}
	}()
	return rule.Evaluate(rc)
}
