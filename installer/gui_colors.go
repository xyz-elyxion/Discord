//go:build !cli

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform gui/cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

package main

import "image/color"

var (
	DiscordGreen        = color.RGBA{0x32, 0x74, 0x44, 0xff}
	DiscordGreenHovered = color.RGBA{0x2d, 0x68, 0x3d, 0xff}
	DiscordRed          = color.RGBA{0xeb, 0x45, 0x45, 0xff}
	DiscordRedHovered   = color.RGBA{0xd8, 0x3c, 0x3c, 0xff}
	DiscordBlue         = color.RGBA{0x58, 0x65, 0xf2, 0xff}
	DiscordBlueHovered  = color.RGBA{0x47, 0x54, 0xd7, 0xff}
	DiscordYellow       = color.RGBA{0xf0, 0xb2, 0x32, 0xff}
)
