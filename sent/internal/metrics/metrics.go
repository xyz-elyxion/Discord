// Package metrics exposes Prometheus-compatible counters.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// DecisionsTotal counts middleware outcomes by site/decision.
	DecisionsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sentinel_decisions_total",
			Help: "Protection decisions issued.",
		},
		[]string{"site", "decision", "degraded", "simulated"},
	)
	// ChallengeOutcomes counts verify successes/failures by reason code.
	ChallengeOutcomes = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sentinel_challenge_outcomes_total",
			Help: "Challenge verification outcomes.",
		},
		[]string{"outcome"}, // verified | expired | replay | malformed | fails
	)
	// EventsDropped counts events dropped when the buffer was full.
	EventsDropped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sentinel_events_dropped_total",
		Help: "Events dropped because the bounded buffer was full (DB too slow).",
	})
	// LoginAttempts counts admin login attempts.
	LoginAttempts = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "sentinel_admin_login_total",
			Help: "Administrator login attempts.",
		},
		[]string{"result"},
	)
)

// Handler exposes /metrics.
func Handler() http.Handler {
	return promhttp.Handler()
}

// labels are interned strings; keep cardinality bounded by site key.
func init() {}
