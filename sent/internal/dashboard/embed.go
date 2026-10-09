// Package dashboard embeds the built admin console.
package dashboard

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed sdk.js
var sdkJS string

//go:embed all:static
var static embed.FS

// Handler serves the dashboard. index.html is served at / and /dashboard/.
// When mounted behind a path prefix (e.g. Limey V1 proxies it at /guard/),
// requests arrive with that prefix still attached; it is stripped here.
// The public browser SDK is exposed at /sdk.js so integrations can load it
// directly from the Sentinel origin, matching docs/integration.md.
func Handler() http.Handler {
	sub, err := fs.Sub(static, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// the browser SDK is public and served at the documented /sdk.js path
		if r.URL.Path == "/sdk.js" {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "public, max-age=300")
			_, _ = io.WriteString(w, sdkJS)
			return
		}
		// mounted under a path prefix (reverse proxy): strip it before lookup
		prefixes := []string{"/guard", "/dashboard"}
		path := r.URL.Path
		for _, p := range prefixes {
			if path == p || strings.HasPrefix(path, p+"/") {
				path = strings.TrimPrefix(path, p)
				break
			}
		}
		if path == "/" || path == "" || path == "/index.html" {
			if path == "" {
				path = "/index.html"
			}
			r2 := r.Clone(r.Context())
			r2.URL.Path = path
			fileServer.ServeHTTP(w, r2)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = path
		fileServer.ServeHTTP(w, r2)
	})
}
