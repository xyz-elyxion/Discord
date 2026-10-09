// Package dashboard embeds the built admin console.
package dashboard

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:static
var static embed.FS

// Handler serves the dashboard. index.html is served at / and /dashboard/.
func Handler() http.Handler {
	sub, err := fs.Sub(static, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// don't allow admin static to advertise index at other paths
		path := strings.TrimPrefix(r.URL.Path, "/dashboard")
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
