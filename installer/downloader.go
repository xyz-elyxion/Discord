/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

package main

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"os"
	path "path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

var InstalledHash = "None"
var LatestHash = "Unknown"
var IsDevInstall bool

var BuildDoneChan chan bool

// Header line written into patcher.js so we can detect the installed version.
// Format: "// Limey <hash>". CSS files are stamped "/* Limey <hash> */".
const HashPrefix = "// Limey "

// parseHashLine extracts the hash from a stamped line, or returns "".
func parseHashLine(line string) string {
	if strings.HasPrefix(line, HashPrefix) {
		return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, HashPrefix), "*/"))
	}
	if strings.HasPrefix(line, "/* Limey ") {
		return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "/* Limey "), "*/"))
	}
	return ""
}

func init() {
	BuildDoneChan = make(chan bool, 1)
	if os.Getenv("LIMEY_DEV_INSTALL") != "" {
		IsDevInstall = true
	}
}

func fileUrl(name string) string {
	return BaseUrl + "/v1/install/files/" + name
}

// setBuildDone safely records the latest build-check/download result for
// whoever wants it. The channel is 1-buffered and consumers are optional —
// the GUI always waits on it (gui.go), the CLI consumes it before patching
// (cli.go), so without this drain a send would deadlock forever whenever a
// previous result was never taken (every CLI run after the init hash-check).
func setBuildDone(ok bool) {
	select {
	case <-BuildDoneChan:
	default:
	}
	BuildDoneChan <- ok
}

func FetchLatestBuilds() (err error) {
	if IsDevInstall {
		setBuildDone(true)
		return nil
	}

	Log.Debug("Installing latest builds...")

	// create an empty package.json file in our files dir.
	// without this, node will walk up the file tree and search for a package.json in the
	// parent folders. This might lead to issues if the user for example has ~/package.json
	// with type: "module" in it
	pkgJsonFile := path.Join(FilesDir, "package.json")
	err = os.WriteFile(pkgJsonFile, []byte("{}"), 0644)
	if err != nil {
		Log.Warn("Failed to create", pkgJsonFile, err)
	}

	var wg sync.WaitGroup
	var downloadedFiles atomic.Uint64
	var firstErr error
	var errMu sync.Mutex

	for _, name := range BuildFiles {
		wg.Add(1)
		ass := name
		go func() {
			defer wg.Done()
			Log.Debug("Downloading file", ass)

			res, err := http.Get(fileUrl(ass))
			if err == nil && res.StatusCode >= 300 {
				err = errors.New(res.Status)
			}
			if err != nil {
				Log.Error("Failed to download", ass+":", err)
				errMu.Lock()
				if firstErr == nil {
					firstErr = errors.New("failed to download " + ass + ": " + err.Error())
				}
				errMu.Unlock()
				return
			}
			outFile := path.Join(FilesDir, ass)
			out, err := os.OpenFile(outFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
			if err != nil {
				Log.Error("Failed to create", outFile+":", err)
				errMu.Lock()
				if firstErr == nil {
					firstErr = errors.New("failed to create " + outFile + ": " + err.Error())
				}
				errMu.Unlock()
				return
			}
			read, err := io.Copy(out, res.Body)
			_ = out.Close()
			_ = res.Body.Close()
			if err != nil {
				Log.Error("Failed to download to", outFile+":", err)
				errMu.Lock()
				if firstErr == nil {
					firstErr = errors.New("failed to download to " + outFile + ": " + err.Error())
				}
				errMu.Unlock()
				return
			}
			if read == 0 {
				Log.Error("downloaded empty file", ass)
				errMu.Lock()
				if firstErr == nil {
					firstErr = errors.New("downloaded empty file " + ass)
				}
				errMu.Unlock()
				return
			}
			downloadedFiles.Add(1)
		}()
	}

	wg.Wait()

	// The per-file goroutines shadow `err`, so the named return never saw
	// their failures — pick up the first one explicitly.
	if firstErr != nil {
		setBuildDone(false)
		return firstErr
	}
	if int(downloadedFiles.Load()) < len(BuildFiles) {
		err = errors.New("Couldn't find all required files")
		setBuildDone(false)
		return err
	}

	Log.Debug("Done!")
	_ = FixOwnership(FilesDir)

	InstalledHash = LatestHash
	setBuildDone(true)
	return nil
}

func init() {
	go func() {
		if IsDevInstall {
			LatestHash = "dev"
			setBuildDone(true)
			return
		}

		// Fetch the hash of the latest build from the backend.
		// The backend stamps every served file with "// Limey <hash>" as its
		// first line, so fetch the tiny renderer.css to learn the hash.
		res, err := http.Get(fileUrl("renderer.css"))
		if err != nil {
			Log.Warn("Failed to check for updates:", err)
			setBuildDone(false)
			return
		}
		defer res.Body.Close()

		if res.StatusCode >= 300 {
			Log.Warn("Failed to check for updates:", res.Status)
			setBuildDone(false)
			return
		}

		scanner := bufio.NewScanner(io.LimitReader(res.Body, 1024))
		if scanner.Scan() {
			if h := parseHashLine(scanner.Text()); h != "" {
				LatestHash = h
				Log.Debug("Latest hash is", LatestHash, "Local Install is", Ternary(LatestHash == InstalledHash, "up to date!", "outdated!"))
			}
		}
		setBuildDone(true)
	}()

	// Check hash of installed version if exists
	f, err := os.Open(path.Join(FilesDir, "patcher.js"))
	if err != nil {
		return
	}
	//goland:noinspection GoUnhandledErrorResult
	defer f.Close()

	Log.Debug("Found existing Limey V1 Install. Checking for hash...")
	scanner := bufio.NewScanner(f)
	if scanner.Scan() {
		if h := parseHashLine(scanner.Text()); h != "" {
			InstalledHash = h
			Log.Debug("Existing hash is", InstalledHash)
		} else {
			Log.Debug("Didn't find hash")
		}
	}
}
