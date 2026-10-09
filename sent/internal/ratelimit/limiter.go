// Package ratelimit provides fixed-window quotas with a Redis backend and an
// in-memory fallback. All backends implement the same interface so the
// middleware code does not care which is active; the active backend is
// observable via the Backend() name and reflected in events.
package ratelimit

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Result of a Limit call.
type Result struct {
	// Allowed is false when the quota is exhausted.
	Allowed bool
	// Remaining requests in the current window.
	Remaining int64
	// ResetAt is when the current window rolls over.
	ResetAt time.Time
	// Backend used ("redis", "memory", or "failclosed" on outage when the
	// configured failure mode demands blocking).
	Backend string
}

// Limiter is the interface the middleware consumes.
type Limiter interface {
	// Limit consumes one unit for key, enforcing max per window.
	Limit(ctx context.Context, key string, max int64, span time.Duration) (Result, error)
	// Observe records a hit without enforcing (used for burst tracking and
	// simulation mode).
	Observe(ctx context.Context, key string) error
	// BurstBusy reports whether the key was flagged for a burst pattern.
	BurstBusy(ctx context.Context, key string) (bool, error)
	// Name identifies the active backend for dashboards.
	Name() string
	// Healthy reports whether the backend is usable.
	Healthy(ctx context.Context) bool
}

// memoryLimiter is a fixed-window limiter with garbage collection.
type memoryLimiter struct {
	mu      sync.Mutex
	windows map[string]*window
	lastGC  time.Time
	maxKeys int
}

type window struct {
	count    int64
	resetsAt time.Time
}

// NewMemory builds an in-memory limiter. Suitable for single-instance
// deployments and as the automatic fallback when Redis is unhealthy.
func NewMemory() Limiter {
	return &memoryLimiter{
		windows: make(map[string]*window),
		maxKeys: 200_000,
		lastGC:  time.Now(),
	}
}

func (m *memoryLimiter) Limit(_ context.Context, key string, max int64, span time.Duration) (Result, error) {
	if max <= 0 || span <= 0 {
		return Result{Allowed: true, Backend: m.Name()}, fmt.Errorf("ratelimit: invalid limit config")
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gcLocked(now)
	w, ok := m.windows[key]
	if !ok || now.After(w.resetsAt) {
		w = &window{count: 0, resetsAt: now.Add(span)}
		m.windows[key] = w
	}
	w.count++
	res := Result{
		Allowed:   w.count <= max,
		Remaining: max - w.count,
		ResetAt:   w.resetsAt,
		Backend:   m.Name(),
	}
	if res.Remaining < 0 {
		res.Remaining = 0
	}
	return res, nil
}

func (m *memoryLimiter) Observe(_ context.Context, key string) error {
	// Observation counters live in their own namespace so Observe never
	// consumes enforce quota.
	_, err := m.record("obs:"+key, time.Minute)
	return err
}

func (m *memoryLimiter) BurstBusy(_ context.Context, key string) (bool, error) {
	w, err := m.record("burst:"+key, 15*time.Second)
	if err != nil {
		return false, err
	}
	// burst heuristic: more than 30 hits within a 15s sub-window
	return w.count > 30, nil
}

// record increments a namespaced window and returns it; lock-safe.
func (m *memoryLimiter) record(key string, span time.Duration) (*window, error) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gcLocked(now)
	w, ok := m.windows[key]
	if !ok || now.After(w.resetsAt) {
		w = &window{count: 0, resetsAt: now.Add(span)}
		m.windows[key] = w
	}
	w.count++
	return w, nil
}

func (m *memoryLimiter) Name() string { return "memory" }

func (m *memoryLimiter) Healthy(_ context.Context) bool { return true }

// gcLocked prunes expired windows; called with the lock held.
func (m *memoryLimiter) gcLocked(now time.Time) {
	if now.Sub(m.lastGC) < 30*time.Second && len(m.windows) < m.maxKeys {
		return
	}
	m.lastGC = now
	for k, w := range m.windows {
		if now.After(w.resetsAt) {
			delete(m.windows, k)
		}
	}
	// emergency cap: cannot grow without bound
	if len(m.windows) > m.maxKeys {
		m.windows = make(map[string]*window, m.maxKeys)
	}
}

// redisLimiter uses INCR+EXPIRE for an atomic fixed window shared across
// instances.
type redisLimiter struct {
	client redisClient
	prefix string
	name   string
}

// redisClient is the subset of go-redis commands we rely on.
type redisClient interface {
	Incr(ctx context.Context, key string) (int64, error)
	ExpireNX(ctx context.Context, key string, ttl time.Duration) (bool, error)
	Ping(ctx context.Context) error
}

// NewRedis builds a Redis-backed limiter. prefix should be namespaced.
func NewRedis(client redisClient, prefix string) Limiter {
	if prefix == "" {
		prefix = "sentinel:rl:"
	}
	return &redisLimiter{client: client, prefix: prefix, name: "redis"}
}

func (r *redisLimiter) Limit(ctx context.Context, key string, max int64, span time.Duration) (Result, error) {
	if max <= 0 || span <= 0 {
		return Result{Allowed: true, Backend: r.Name()}, fmt.Errorf("ratelimit: invalid limit config")
	}
	full := r.prefix + key
	n, err := r.client.Incr(ctx, full)
	if err != nil {
		return Result{}, err
	}
	if n == 1 {
		// First increment in this window: set TTL only if absent.
		_, _ = r.client.ExpireNX(ctx, full, span)
	}
	// remaining seconds until expiry is approximated client-side as the
	// window length (Redis TTL is exactly that when set on first hit)
	return Result{
		Allowed:   n <= max,
		Remaining: max - n,
		ResetAt:   time.Now().Add(span),
		Backend:   r.Name(),
	}, nil
}

func (r *redisLimiter) Observe(ctx context.Context, key string) error {
	_, err := r.client.Incr(ctx, r.prefix+"obs:"+key)
	return err
}

func (r *redisLimiter) BurstBusy(_ context.Context, key string) (bool, error) {
	n, err := r.client.Incr(context.Background(), r.prefix+"burst:"+key)
	if err != nil {
		return false, err
	}
	// heuristic: >30 within the current short window is a burst
	return n > 30, nil
}

func (r *redisLimiter) Name() string { return r.name }

func (r *redisLimiter) Healthy(ctx context.Context) bool {
	return r.client.Ping(ctx) == nil
}
