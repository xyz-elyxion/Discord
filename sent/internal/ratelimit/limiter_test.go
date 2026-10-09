package ratelimit

import (
	"context"
	"testing"
	"time"
)

func TestMemoryLimitEnforcesQuota(t *testing.T) {
	l := NewMemory()
	ctx := context.Background()
	for i := 1; i <= 3; i++ {
		res, err := l.Limit(ctx, "k1", 3, time.Minute)
		if err != nil {
			t.Fatalf("limit %d: %v", i, err)
		}
		if !res.Allowed {
			t.Fatalf("request %d should be allowed", i)
		}
		if res.Remaining != int64(3-i) {
			t.Fatalf("remaining = %d, want %d", res.Remaining, 3-i)
		}
	}
	res, err := l.Limit(ctx, "k1", 3, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if res.Allowed {
		t.Fatal("4th request should be denied")
	}
	if res.Remaining != 0 {
		t.Fatalf("remaining after denial = %d, want 0", res.Remaining)
	}
	if res.Backend != "memory" {
		t.Fatalf("backend = %s", res.Backend)
	}
}

func TestMemoryWindowReset(t *testing.T) {
	// Shrink window; after reset the key gets a fresh quota. We verify by
	// using a short span and real sleeps (fast enough here).
	l := NewMemory()
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if res, _ := l.Limit(ctx, "k2", 2, 60*time.Millisecond); !res.Allowed {
			t.Fatalf("iteration %d should be allowed", i)
		}
	}
	if res, _ := l.Limit(ctx, "k2", 2, 60*time.Millisecond); res.Allowed {
		t.Fatal("3rd should be denied")
	}
	time.Sleep(80 * time.Millisecond)
	if res, _ := l.Limit(ctx, "k2", 2, 60*time.Millisecond); !res.Allowed {
		t.Fatal("after window reset should be allowed")
	}
}

func TestMemoryKeysAreIndependent(t *testing.T) {
	l := NewMemory()
	ctx := context.Background()
	if res, _ := l.Limit(ctx, "a", 1, time.Minute); !res.Allowed {
		t.Fatal("a should pass")
	}
	if res, _ := l.Limit(ctx, "b", 1, time.Minute); !res.Allowed {
		t.Fatal("b should pass independently")
	}
	if res, _ := l.Limit(ctx, "a", 1, time.Minute); res.Allowed {
		t.Fatal("a quota exhausted")
	}
}

func TestInvalidConfig(t *testing.T) {
	l := NewMemory()
	ctx := context.Background()
	if _, err := l.Limit(ctx, "k", 0, time.Minute); err == nil {
		t.Fatal("expected error for zero quota")
	}
	if _, err := l.Limit(ctx, "k", 3, 0); err == nil {
		t.Fatal("expected error for zero window")
	}
}

func TestBurstBusy(t *testing.T) {
	l := NewMemory()
	ctx := context.Background()
	// BurstBusy maintains its own 15s sub-window counter, so we tick it directly.
	for i := 0; i < 35; i++ {
		busy, err := l.BurstBusy(ctx, "bursty")
		if err != nil {
			t.Fatal(err)
		}
		if i >= 30 && !busy {
			t.Fatalf("expected burst detection on hit %d", i)
		}
	}
	busy, _ := l.BurstBusy(ctx, "quiet")
	if busy {
		t.Fatal("first hit should not be flagged")
	}
}

// fakeRedis is a minimal in-process stand-in for the redis client interface.
type fakeRedis struct {
	vals map[string]int64
}

func (f *fakeRedis) Incr(_ context.Context, key string) (int64, error) {
	if f.vals == nil {
		f.vals = make(map[string]int64)
	}
	f.vals[key]++
	return f.vals[key], nil
}

func (f *fakeRedis) ExpireNX(_ context.Context, _ string, _ time.Duration) (bool, error) {
	return true, nil
}

func (f *fakeRedis) Ping(_ context.Context) error { return nil }

func TestRedisLimiterShadowsMemory(t *testing.T) {
	l := NewRedis(&fakeRedis{}, "test:")
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		res, err := l.Limit(ctx, "k", 3, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if !res.Allowed {
			t.Fatalf("request %d should be allowed", i+1)
		}
	}
	res, err := l.Limit(ctx, "k", 3, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if res.Allowed {
		t.Fatal("4th should be denied")
	}
	if res.Backend != "redis" {
		t.Fatalf("backend = %s", res.Backend)
	}
}

func TestObserve(t *testing.T) {
	l := NewMemory()
	ctx := context.Background()
	// Exhaust the enforce quota first; Observe must not error and
	// ObserveMustUseItsOwnNamespaces separately verifies independence.
	if _, err := l.Limit(ctx, "k", 1, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := l.Observe(ctx, "k"); err != nil {
		t.Fatal(err)
	}
}

func TestObserveOwnNamespace(t *testing.T) {
	l := NewMemory()
	ctx := context.Background()
	// memoryLimiter shares one window map keyed by string, so observe keys and
	// enforce keys must not collide in a way that lets observe consume quota.
	// We indirectly verify by limiting with max 1 after observing once.
	if err := l.Observe(ctx, "q"); err != nil {
		t.Fatal(err)
	}
	res, _ := l.Limit(ctx, "q", 1, time.Minute)
	if !res.Allowed {
		t.Fatal("observe consumed enforce quota — implementations must namespace counters")
	}
}

func TestHealthy(t *testing.T) {
	m := NewMemory()
	if !m.Healthy(context.Background()) {
		t.Fatal("memory limiter is always healthy")
	}
	r := NewRedis(&fakeRedis{}, "")
	if !r.Healthy(context.Background()) {
		t.Fatal("fake redis pings ok")
	}
}
