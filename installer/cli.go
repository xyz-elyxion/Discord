//go:build cli

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform gui/cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 */

package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"
	"vencordinstaller/buildinfo"

	"github.com/fatih/color"
	"github.com/manifoldco/promptui"
)

var discords []any
var interactive = false

func isValidBranch(branch string) bool {
	switch branch {
	case "", "stable", "ptb", "canary", "auto":
		return true
	default:
		return false
	}
}

func die(msg string) {
	Log.Error(msg)
	exitFailure()
}

func main() {

	discords = FindDiscords()

	// Used by log.go init func
	flag.Bool("debug", false, "Enable debug info")

	var helpFlag = flag.Bool("help", false, "View usage instructions")
	var versionFlag = flag.Bool("version", false, "View the program version")
	var updateSelfFlag = flag.Bool("update-self", false, "Update me to the latest version")
	var installFlag = flag.Bool("install", false, "Install Limey V1")
	var updateFlag = flag.Bool("repair", false, "Repair Limey V1")
	var uninstallFlag = flag.Bool("uninstall", false, "Uninstall Limey V1")
	var locationFlag = flag.String("location", "", "The location of the Discord install to modify")
	var branchFlag = flag.String("branch", "", "The branch of Discord to modify [auto|stable|ptb|canary]")
	flag.Parse()

	if *helpFlag {
		flag.Usage()
		return
	}

	if *versionFlag {
		fmt.Println("Limey V1 Installer Cli", buildinfo.InstallerTag, "("+buildinfo.InstallerGitHash+")")
		fmt.Println("Copyright (C) 2026 Limey V1 contributors")
		fmt.Println("License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.")
		return
	}

	if *updateSelfFlag {
		if !<-SelfUpdateCheckDoneChan {
			die("Can't update self because checking for updates failed")
		}
		if err := UpdateSelf(); err != nil {
			Log.Error("Failed to update self:", err)
			exitFailure()
		}
		exitSuccess()
	}

	if *locationFlag != "" && *branchFlag != "" {
		die("The 'location' and 'branch' flags are mutually exclusive.")
	}

	if !isValidBranch(*branchFlag) {
		die("The 'branch' flag must be one of the following: [auto|stable|ptb|canary]")
	}

	if *installFlag || *updateFlag {
		if false {
			die("Not " + Ternary(*installFlag, "installing", "updating") + " as fetching build data failed. If this issue persists, see https://limey-discord.onrender.com/404.html")
		}
	}

	install, uninstall, update := *installFlag, *uninstallFlag, *updateFlag
	switches := []*bool{&install, &update, &uninstall}
	if !SliceContainsFunc(switches, func(b *bool) bool { return *b }) {
		interactive = true

		go func() {
			<-SelfUpdateCheckDoneChan
			if IsSelfOutdated {
				Log.Warn("Your installer is outdated.")
				Log.Warn("To update, select the 'Update Limey V1 Installer' option to update, or run with --update-self")
			}
		}()

		choices := []string{
			"Install Limey V1",
			"Repair Limey V1",
			"Uninstall Limey V1",
			"View Help Menu",
			"Update Limey V1 Installer",
			"Quit",
		}
		_, choice, err := (&promptui.Select{
			Label: "What would you like to do? (Press Enter to confirm)",
			Items: choices,
		}).Run()
		handlePromptError(err)

		switch choice {
		case "View Help Menu":
			flag.Usage()
			return
		case "Quit":
			return
		case "Update Limey V1 Installer":
			if err := UpdateSelf(); err != nil {
				Log.Error("Failed to update self:", err)
				exitFailure()
			}
			exitSuccess()
		}

		*switches[SliceIndex(choices, choice)] = true
	}

	var err error
	var errSilent error
	if install {
		errSilent = PromptDiscord("patch", *locationFlag, *branchFlag).patch()
	} else if uninstall {
		errSilent = PromptDiscord("unpatch", *locationFlag, *branchFlag).unpatch()
	} else if update {
		Log.Info("Downloading latest Limey V1 files...")
		err := FetchLatestBuilds()
		Log.Info("Done!")
		if err == nil {
			errSilent = PromptDiscord("repair", *locationFlag, *branchFlag).patch()
		}
	}

	if err != nil {
		Log.Error(err)
		exitFailure()
	}
	if errSilent != nil {
		exitFailure()
	}

	exitSuccess()
}

func exit(status int) {
	if runtime.GOOS == "windows" && IsDoubleClickRun() && interactive {
		fmt.Print("Press Enter to exit")
		var b byte
		_, _ = fmt.Scanf("%v", &b)
	}
	os.Exit(status)
}

func exitSuccess() {
	color.HiGreen("✔ Success!")
	exit(0)
}

func exitFailure() {
	color.HiRed("❌ Failed! If this issue persists, see https://limey-discord.onrender.com/404.html")
	exit(1)
}

func handlePromptError(err error) {
	if errors.Is(err, promptui.ErrInterrupt) {
		exit(0)
	}

	Log.FatalIfErr(err)
}

func PromptDiscord(action, dir, branch string) *DiscordInstall {
	if branch == "auto" {
		for _, b := range []string{"stable", "canary", "ptb"} {
			for _, discord := range discords {
				install := discord.(*DiscordInstall)
				if install.branch == b {
					return install
				}
			}
		}
		die("No Discord install found. Before proceeding, make sure Discord is installed. snap is not supported!")
	}

	if branch != "" {
		for _, discord := range discords {
			install := discord.(*DiscordInstall)
			if install.branch == branch {
				return install
			}
		}
		die("Discord " + branch + " not found")
	}

	if dir != "" {
		if discord := ParseDiscord(dir, branch); discord != nil {
			return discord
		}

		if discord := ParseDiscordNew(dir, branch, strings.Contains(dir, "com.discordapp")); discord != nil {
			return discord
		}

		die(dir + " is not a valid Discord install. Hint: snap is not supported")
	}

	items := SliceMap(discords, func(d any) string {
		install := d.(*DiscordInstall)
		//goland:noinspection GoDeprecation
		return fmt.Sprintf("%s - %s%s", strings.Title(install.branch), install.path, Ternary(install.isPatched, " [Limey V1 Installed]", ""))
	})
	items = append(items, "Custom Location")

	_, choice, err := (&promptui.Select{
		Label: "Select Discord install to " + action + " (Press Enter to confirm)",
		Items: items,
	}).Run()
	handlePromptError(err)

	if choice != "Custom Location" {
		return discords[SliceIndex(items, choice)].(*DiscordInstall)
	}

	for {
		custom, err := (&promptui.Prompt{
			Label: "Custom Discord Location",
		}).Run()
		handlePromptError(err)

		if di := ParseDiscord(custom, ""); di != nil {
			return di
		}

		if di := ParseDiscordNew(custom, "", strings.Contains(custom, "com.discordapp")); di != nil {
			return di
		}

		Log.Error("Invalid Discord install!")
	}
}

func InstallLatestBuilds() error {
	if IsDevInstall {
		return nil
	}

	return FetchLatestBuilds()
}

func HandleScuffedInstall() {
	fmt.Println("Hold On!")
	fmt.Println("You have a broken Discord Install.")
	fmt.Println("Please reinstall Discord before proceeding!")
	fmt.Println("Otherwise, Limey V1 will likely not work.")
}
