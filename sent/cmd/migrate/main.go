// Migration runner applies SQL files from migrations/ in lexical order.
//
// Usage:
//
//	sentinel-migrate -dsn "$SENTINEL_PG_DSN"            # apply pending
//	sentinel-migrate -dsn ... -status                    # show state
package main

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed all:sql
var sqlFS embed.FS

type mig struct {
	name string
	body string
}

func main() {
	dsn := flag.String("dsn", os.Getenv("SENTINEL_PG_DSN"), "postgres DSN")
	status := flag.Bool("status", false, "print migration state and exit")
	flag.Parse()
	if strings.TrimSpace(*dsn) == "" {
		fmt.Fprintln(os.Stderr, "error: -dsn or SENTINEL_PG_DSN required")
		os.Exit(2)
	}
	if err := run(*dsn, *status); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
}

func listMigrations() ([]mig, error) {
	entries, err := sqlFS.ReadDir("sql")
	if err != nil {
		return nil, err
	}
	var out []mig
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		body, err := sqlFS.ReadFile("sql/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, mig{name: name, body: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

func run(dsn string, statusOnly bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("database unreachable: %w", err)
	}
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return err
	}
	migs, err := listMigrations()
	if err != nil {
		return err
	}
	applied := map[string]bool{}
	rows, err := db.QueryContext(ctx, `SELECT name FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return err
		}
		applied[n] = true
	}
	rows.Close()

	pending := 0
	for _, m := range migs {
		if applied[m.name] {
			fmt.Printf("= applied  %s\n", m.name)
			continue
		}
		if statusOnly {
			fmt.Printf("! pending  %s\n", m.name)
			pending++
			continue
		}
		fmt.Printf("→ applying %s ... ", m.name)
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.body); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply %s: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (name) VALUES ($1)`, m.name); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		fmt.Println("done")
		pending++
	}
	if statusOnly && pending == 0 {
		fmt.Println("all migrations applied")
	}
	if !statusOnly && pending == 0 {
		fmt.Println("nothing to apply")
	}
	return nil
}

var _ = errors.New
