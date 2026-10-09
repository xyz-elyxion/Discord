package verification

import (
	"context"
	"sync"
	"time"
)

// ReplayStore marks token IDs as consumed. Implementations must be safe for
// concurrent use.
type ReplayStore interface {
	// Consume atomically marks id as used. Returns nil on first use, or
	// ErrReplayed when the id was already consumed.
	// ttl is how long to remember the id (token lifetime).
	Consume(id string, ttl time.Duration) error
}

// memoryReplay is an in-memory TTL replay cache. Bounded by periodic
// pruning; entries expire after ttl.
type memoryReplay struct {
	mu       sync.Mutex
	entries  map[string]time.Time
	maxEntry int // soft bound on map size
}

// NewMemoryReplay builds an in-memory replay cache. Suitable for:
//   - tests
//   - single-process deployments
//   - Redis-unavailable fallbacks (with documented caveat: replay protection
//     is per-instance only)
func NewMemoryReplay() ReplayStore {
	return &memoryReplay{
		entries:  make(map[string]time.Time),
		maxEntry: 100_000,
	}
}

func (m *memoryReplay) Consume(id string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = time.Minute
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.entries[id]; ok && t.After(now) {
		return ErrReplayed
	}
	// prune when excessively large so the map cannot grow unbounded
	if len(m.entries) > m.maxEntry {
		for k, v := range m.entries {
			if v.Before(now) {
				delete(m.entries, k)
			}
		}
	}
	if len(m.entries) > m.maxEntry {
		// still full: drop oldest insertions by clearing — crude but bounded
		m.entries = make(map[string]time.Time, m.maxEntry)
	}
	m.entries[id] = now.Add(ttl)
	return nil
}

// redisReplay uses Redis SET NX EX, so replay protection is shared across
// instances of a horizontally scaled deployment.
type redisReplay struct {
	client redisClient
	prefix string
}

// redisClient is the minimal Redis surface we rely on, so tests can stub it.
type redisClient interface {
	SetNX(ctx context.Context, key string, value any, expiration time.Duration) (bool, error)
}

// NewRedisReplay wraps a go-redis client. prefix should be namespaced (e.g.
// "sentinel:replay:").
func NewRedisReplay(client redisClient, prefix string) ReplayStore {
	if prefix == "" {
		prefix = "sentinel:replay:"
	}
	return &redisReplay{client: client, prefix: prefix}
}

func (r *redisReplay) Consume(id string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ok, err := r.client.SetNX(ctx, r.prefix+id, 1, ttl)
	if err != nil {
		// Deps: never silently bypass. Callers decide fail-open/closed.
		return err
	}
	if !ok {
		return ErrReplayed
	}
	return nil
}
