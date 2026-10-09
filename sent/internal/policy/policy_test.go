package policy

import (
	"testing"
	"time"
)

func TestThresholdsValidate(t *testing.T) {
	ok := Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid thresholds rejected: %v", err)
	}
	bad := []Thresholds{
		{},
		{ChallengeThreshold: 80, ThrottleThreshold: 50, BlockThreshold: 20},
		{ChallengeThreshold: 20, ThrottleThreshold: 20, BlockThreshold: 80},
	}
	for _, b := range bad {
		if err := b.Validate(); err == nil {
			t.Fatalf("expected rejection of %+v", b)
		}
	}
}

func TestDecide(t *testing.T) {
	th := Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}
	cases := []struct {
		score    float64
		verified bool
		require  bool
		want     Decision
	}{
		{5, false, false, Allow},
		{25, false, false, Challenge},
		{55, false, false, Throttle},
		{90, false, false, Block},
		// verified: challenge band becomes allow unless route requires verification
		{25, true, false, Allow},
		// verified but still very suspicious → throttle/block still apply
		{55, true, false, Throttle},
		// requireVerified: even verified traffic respects the score path
		{25, true, true, Challenge},
	}
	for _, c := range cases {
		got := th.Decide(c.score, c.verified, c.require)
		if got != c.want {
			t.Fatalf("Decide(%v, verified=%v, req=%v) = %v, want %v", c.score, c.verified, c.require, got, c.want)
		}
	}
}

func TestEvaluatePolLists(t *testing.T) {
	ev := &Evaluator{DefaultThresholds: Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}}
	p := RoutePolicy{ID: "p1", SiteKey: "s"}

	// denylist wins
	out := ev.EvaluatePol(p, 5, false, false, true, false, true)
	if out.Decision != Block {
		t.Fatalf("denylist should block, got %v", out.Decision)
	}
	// allowlist wins
	out = ev.EvaluatePol(p, 85, false, true, false, false, true)
	if out.Decision != Allow {
		t.Fatalf("allowlist should allow, got %v", out.Decision)
	}
	// requireVerified overrides allowlist? No: allowlist short-circuits first.
	p2 := RoutePolicy{ID: "p2", SiteKey: "s", RequireVerified: true}
	out = ev.EvaluatePol(p2, 5, false, true, false, false, true)
	if out.Decision != Allow {
		t.Fatalf("allowlist short-circuits requireVerified, got %v", out.Decision)
	}
	// requireVerified unauthenticated → challenge
	out = ev.EvaluatePol(p2, 0, false, false, false, false, true)
	if out.Decision != Challenge {
		t.Fatalf("requireVerified should challenge, got %v", out.Decision)
	}
}

func TestFailModes(t *testing.T) {
	ev := &Evaluator{}
	pOpen := RoutePolicy{ID: "open", SiteKey: "s", FailureMode: FailOpen}
	out := ev.EvaluatePol(pOpen, 90, false, false, false, false, false)
	if out.Decision != Allow || !out.Degraded {
		t.Fatalf("fail-open during outage: %+v", out)
	}
	pClosed := RoutePolicy{ID: "closed", SiteKey: "s", FailureMode: FailClosed}
	out = ev.EvaluatePol(pClosed, 90, false, false, false, false, false)
	if out.Decision != Block || !out.Degraded {
		t.Fatalf("fail-closed during outage: %+v", out)
	}
	// default (empty) behaves like fail-closed
	pDefault := RoutePolicy{ID: "def", SiteKey: "s"}
	out = ev.EvaluatePol(pDefault, 90, false, false, false, false, false)
	if out.Decision != Block {
		t.Fatalf("default failure mode should be fail-closed, got %v", out.Decision)
	}
}

func TestSimulationFlag(t *testing.T) {
	ev := &Evaluator{DefaultThresholds: Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}}
	p := RoutePolicy{ID: "sim", SiteKey: "s", Simulation: true}
	out := ev.EvaluatePol(p, 90, false, false, false, false, true)
	if out.Decision != Block {
		t.Fatalf("simulation should still compute decisions, got %v", out.Decision)
	}
	if !out.Simulated {
		t.Fatal("simulation flag must be propagated")
	}
}

func TestMatches(t *testing.T) {
	p := RoutePolicy{SiteKey: "s1", Hostname: "a.com", Method: "POST", PathPrefix: "/api/"}
	if !p.Matches("s1", "a.com", "POST", "/api/contact") {
		t.Fatal("expected match")
	}
	if p.Matches("s2", "a.com", "POST", "/api/contact") {
		t.Fatal("wrong site should not match")
	}
	if p.Matches("s1", "b.com", "POST", "/api/contact") {
		t.Fatal("wrong host should not match")
	}
	if p.Matches("s1", "a.com", "GET", "/api/contact") {
		t.Fatal("wrong method should not match")
	}
	if p.Matches("s1", "a.com", "POST", "/other") {
		t.Fatal("wrong path should not match")
	}
}

func TestOutcomeFromApply(t *testing.T) {
	p := RoutePolicy{ID: "rl", SiteKey: "s"}
	out := OutcomeFromApply(p, true, true)
	if out.Decision != Throttle {
		t.Fatalf("limited should throttle, got %v", out.Decision)
	}
	out = OutcomeFromApply(p, false, true)
	if out.Decision != Allow {
		t.Fatalf("unlimited should allow, got %v", out.Decision)
	}
	// outage fail-closed
	pC := RoutePolicy{ID: "rl2", SiteKey: "s", FailureMode: FailClosed}
	out = OutcomeFromApply(pC, false, false)
	if out.Decision != Block || !out.Degraded {
		t.Fatalf("fail-closed outage: %+v", out)
	}
	_ = time.Second
}

func TestParseDecision(t *testing.T) {
	for _, s := range []string{"allow", "Challenge", " block "} {
		if _, err := ParseDecision(s); err != nil {
			t.Fatalf("expected %q to parse", s)
		}
	}
	if _, err := ParseDecision("bogus"); err == nil {
		t.Fatal("expected error")
	}
}
