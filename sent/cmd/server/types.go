package main

import (
	"context"
	"net/http"
	"time"

	"limey.example/sentinel/internal/storage"
)

// Small aliases used by handlers/admin files.
type (
	contextCtx = context.Context
	cancelFunc = context.CancelFunc
	storeT     = storage.Store
)

func contextWithDeadline(r *http.Request, d time.Duration) (contextCtx, cancelFunc) {
	ctx, cancel := context.WithTimeout(r.Context(), d)
	return ctx, cancel
}
