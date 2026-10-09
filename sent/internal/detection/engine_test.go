package detection

import (
	"sort"
	"testing"
)

func TestEngineSumsWeightsAndRecommends(t *testing.T) {
	w := func(n string, weight float64, a Action) Rule {
		return stubRule{name: n, weight: weight, action: a}
	}
	e := New(
		w("a", 10, Challenge),
		w("b", 20, Block),
		w("c", 5, ""),
	)
	res := e.Evaluate(RequestContext{})
	if res.Score != 35 {
		t.Fatalf("score = %v, want 35", res.Score)
	}
	if len(res.Triggered) != 3 {
		t.Fatalf("triggered = %d, want 3", len(res.Triggered))
	}
	if res.Recommended != Challenge {
		t.Fatalf("recommended = %v, want challenge (first rule's opinion)", res.Recommended)
	}
}

func TestEngineDisable(t *testing.T) {
	r := stubRule{name: "muted", weight: 100, action: Block}
	e := New(r)
	e.Disable("muted")
	res := e.Evaluate(RequestContext{})
	if res.Score != 0 || len(res.Triggered) != 0 {
		t.Fatalf("disabled rule still fired: %+v", res)
	}
	e.Enable("muted")
	res = e.Evaluate(RequestContext{})
	if res.Score != 100 {
		t.Fatalf("re-enabled rule did not fire: %+v", res)
	}
}

func TestRuleNamesSorted(t *testing.T) {
	e := New(stubRule{name: "z"}, stubRule{name: "a"}, stubRule{name: "m"})
	got := e.RuleNames()
	want := []string{"a", "m", "z"}
	sort.Strings(want)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("names = %v, want %v", got, want)
		}
	}
}

func TestPanicIsolated(t *testing.T) {
	e := New(panicRule{}, stubRule{name: "ok", weight: 7, action: Throttle})
	res := e.Evaluate(RequestContext{})
	if res.Score != 7 {
		t.Fatalf("score = %v, want 7", res.Score)
	}
}

type stubRule struct {
	name   string
	weight float64
	action Action
}

func (s stubRule) Name() string { return s.name }
func (s stubRule) Evaluate(RequestContext) Contribution {
	return Contribution{Weight: s.weight, Action: s.action}
}

type panicRule struct{}

func (panicRule) Name() string { return "panicky" }
func (panicRule) Evaluate(RequestContext) Contribution {
	panic("boom")
}

func TestBurstRule(t *testing.T) {
	r := BurstRule{Threshold: 60, MaxWeight: 30, Action: Throttle, Severity: SeverityWarn}
	// below threshold and no burst: silent
	c := r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{RequestsPerMinute: 10}, RouteExpectations{}))
	if c.Weight != 0 {
		t.Fatalf("want silent below threshold, got %+v", c)
	}
	// burst flag alone fires
	c = r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{RequestsPerMinute: 10, Burst: true}, RouteExpectations{}))
	if c.Weight == 0 || c.Action != Throttle {
		t.Fatalf("burst should fire: %+v", c)
	}
	// above threshold scales weight
	c = r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{RequestsPerMinute: 600}, RouteExpectations{}))
	if c.Weight != 30 { // clamped to max
		t.Fatalf("weight = %v, want 30 (clamped)", c.Weight)
	}
}

func TestChallengeFailureRule(t *testing.T) {
	r := ChallengeFailureRule{Threshold: 3, Weight: 25, Action: Block, Severity: SeverityHigh}
	c := r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{ChallengeFailuresRecent: 2}, RouteExpectations{}))
	if c.Weight != 0 {
		t.Fatalf("below threshold should be silent, got %+v", c)
	}
	c = r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{ChallengeFailuresRecent: 5}, RouteExpectations{}))
	if c.Weight != 25 || c.Action != Block {
		t.Fatalf("fired: %+v", c)
	}
}

func TestIdenticalSubmissionRule(t *testing.T) {
	r := IdenticalSubmissionRule{Threshold: 5, Weight: 20, Action: Challenge, Severity: SeverityWarn}
	c := r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{IdenticalSubmissionCount: 4}, RouteExpectations{}))
	if c.Weight != 0 {
		t.Fatalf("below threshold should be silent: %+v", c)
	}
	c = r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{IdenticalSubmissionCount: 7}, RouteExpectations{}))
	if c.Weight != 20 {
		t.Fatalf("fired: %+v", c)
	}
}

func TestHeaderAnomalyRule(t *testing.T) {
	r := HeaderAnomalyRule{Weight: 8, Action: Challenge, Severity: SeverityInfo}
	// no expectations configured: silent (default required is empty)
	c := r.Evaluate(WithSnapshot(Request{}, CounterSnapshot{}, RouteExpectations{}))
	if c.Weight != 0 {
		t.Fatalf("expected silent with no defaults, got %+v", c)
	}
	r2 := HeaderAnomalyRule{Weight: 8, DefaultRequired: []string{"accept", "accept-encoding"}, Action: Challenge}
	c = r2.Evaluate(WithSnapshot(Request{Headers: map[string]string{"accept": "text/html"}}, CounterSnapshot{}, RouteExpectations{}))
	if c.Weight != 8 { // 1 missing header * weight
		t.Fatalf("missing header weight = %v, want 8", c.Weight)
	}
}

func TestParseAction(t *testing.T) {
	for _, s := range []string{"allow", "Challenge", " throttle ", "BLOCK"} {
		if _, err := ParseAction(s); err != nil {
			t.Fatalf("expected %q to parse", s)
		}
	}
	if _, err := ParseAction("nope"); err == nil {
		t.Fatal("expected error")
	}
}
