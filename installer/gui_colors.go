//go:build !cli

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform gui/cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

// Package-level color tokens. The Limey V1 site palette lives in
// gui_theme.go; this file keeps only the icons the theme doesn't cover.

package main

import "image/color"

var (
	SuccessGreen          = color.RGBA{0x3b, 0xa5, 0x5c, 0xff} // ok state on the site (#3ba55c)
	SuccessGreenHovered   = color.RGBA{0x2d, 0x81, 0x46, 0xff}
	DestructiveRed        = color.RGBA{0xb9, 0x1c, 0x1c, 0xff} // --destructive
	DestructiveRedHovered = color.RGBA{0x99, 0x17, 0x17, 0xff}
	InfoBlue              = color.RGBA{0x58, 0x65, 0xf2, 0xff}
	InfoBlueHovered       = color.RGBA{0x47, 0x54, 0xd7, 0xff}
	WarnYellow            = color.RGBA{0xf0, 0xb2, 0x32, 0xff}
)
