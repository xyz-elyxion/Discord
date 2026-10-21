//go:build !cli

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform gui/cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

package main

import (
	"image/color"

	g "github.com/AllenDang/giu"
	"github.com/AllenDang/imgui-go"
)

// Limey V1 site palette (public/style.css) — dark neutral base with the
// lime accent. The old Discord brand colors moved next to them: they still
// color the three action buttons so "Install/Repair/Uninstall" stays
// recognizable to users coming from Vencord.
var (
	// Site tokens
	LimeyBackground = color.RGBA{0x09, 0x09, 0x0b, 0xff} // --background
	LimeyForeground = color.RGBA{0xfa, 0xfa, 0xfa, 0xff} // --foreground
	LimeyCard       = color.RGBA{0x17, 0x17, 0x17, 0xff} // --card
	LimeyMuted      = color.RGBA{0xa1, 0xa1, 0xaa, 0xff} // --muted-foreground
	LimeyBorder     = color.RGBA{0x26, 0x26, 0x26, 0xff} // --border
	LimeyInput      = color.RGBA{0x2a, 0x2a, 0x2e, 0xff} // --input
	LimeyAccent     = color.RGBA{0x23, 0x23, 0x26, 0xff} // --accent
	LimeyPopup      = color.RGBA{0x10, 0x10, 0x13, 0xff} // --popover
	LimeyLime       = color.RGBA{0x9c, 0xcc, 0x3c, 0xff} // --primary
	LimeyLimeBright = color.RGBA{0xa8, 0xd8, 0x4a, 0xff} // --lime-strong
	LimeyLimeDark   = color.RGBA{0x1a, 0x2e, 0x05, 0xff} // --lime-dark

	// Kept from the old Discord-styled UI (hover variants slightly darker)
	DiscordGreen        = color.RGBA{0x32, 0x74, 0x44, 0xff}
	DiscordGreenHovered = color.RGBA{0x2d, 0x68, 0x3d, 0xff}
	DiscordRed          = color.RGBA{0xeb, 0x45, 0x45, 0xff}
	DiscordRedHovered   = color.RGBA{0xd8, 0x3c, 0x3c, 0xff}
	DiscordBlue         = color.RGBA{0x58, 0x65, 0xf2, 0xff}
	DiscordBlueHovered  = color.RGBA{0x47, 0x54, 0xd7, 0xff}
	DiscordYellow       = color.RGBA{0xf0, 0xb2, 0x32, 0xff}
)

// pushLimeyTheme applies the Limey V1 look globally for the current frame:
// dark surfaces, rounded frames and the lime checkmark. Wrapped by
// pushLimeyTheme/popLimeyTheme around the frame; the per-widget styles
// (buttons etc.) stay local in gui.go like before.
func pushLimeyTheme() {
	// Text + window surfaces
	g.PushStyleColor(g.StyleColorText, LimeyForeground)
	g.PushStyleColor(g.StyleColorTextDisabled, LimeyMuted)
	g.PushStyleColor(g.StyleColorWindowBg, LimeyBackground)
	g.PushStyleColor(g.StyleColorChildBg, LimeyCard)
	g.PushStyleColor(g.StyleColorPopupBg, LimeyPopup)
	g.PushStyleColor(g.StyleColorModalWindowDimBg, color.RGBA{0x00, 0x00, 0x00, 0xb4})
	// Frames (checkbox, input)
	g.PushStyleColor(g.StyleColorFrameBg, LimeyInput)
	g.PushStyleColor(g.StyleColorFrameBgHovered, LimeyAccent)
	g.PushStyleColor(g.StyleColorFrameBgActive, LimeyAccent)
	// Title bar
	g.PushStyleColor(g.StyleColorTitleBg, LimeyCard)
	g.PushStyleColor(g.StyleColorTitleBgActive, LimeyCard)
	g.PushStyleColor(g.StyleColorTitleBgCollapsed, LimeyCard)
	// Controls
	g.PushStyleColor(g.StyleColorButton, LimeyCard)
	g.PushStyleColor(g.StyleColorButtonHovered, LimeyAccent)
	g.PushStyleColor(g.StyleColorButtonActive, LimeyAccent)
	g.PushStyleColor(g.StyleColorCheckMark, LimeyLime)
	g.PushStyleColor(g.StyleColorSeparator, LimeyBorder)
	// Scrollbars
	g.PushStyleColor(g.StyleColorScrollbarBg, LimeyCard)
	g.PushStyleColor(g.StyleColorScrollbarGrab, LimeyInput)
	g.PushStyleColor(g.StyleColorScrollbarGrabHovered, LimeyAccent)
	g.PushStyleColor(g.StyleColorScrollbarGrabActive, LimeyLimeDark)

	// Rounded frames (matches --radius: 0.75rem of the site) and roomier
	// spacing — float values are pushed through the imgui layer directly
	// because giu v0.6.2 exposes only the vec2 var helpers globally.
	imgui.PushStyleVarFloat(imgui.StyleVarFrameRounding, 10)
	imgui.PushStyleVarFloat(imgui.StyleVarWindowRounding, 12)
	imgui.PushStyleVarFloat(imgui.StyleVarPopupRounding, 14)
	imgui.PushStyleVarFloat(imgui.StyleVarGrabRounding, 8)
	imgui.PushStyleVarFloat(imgui.StyleVarScrollbarRounding, 8)
	imgui.PushStyleVarFloat(imgui.StyleVarTabRounding, 8)
	imgui.PushStyleVarFloat(imgui.StyleVarWindowBorderSize, 0)
	// NOTE: use imgui directly, not g.PushFramePadding/g.PushItemSpacing:
	// giu v0.6.2's PushFramePadding pushes a second hidden style var
	// (SelectableTextAlign), which silently desynchronized the push/pop
	// counts and eventually tripped the VC runtime "assert Size > 0"
	// (imgui.h:1752) on the frame's style stack.
	imgui.PushStyleVarVec2(imgui.StyleVarFramePadding, imgui.Vec2{X: 8, Y: 6})
	imgui.PushStyleVarVec2(imgui.StyleVarItemSpacing, imgui.Vec2{X: 8, Y: 8})
}

func popLimeyTheme() {
	g.PopStyleV(2)        // FramePadding + ItemSpacing
	imgui.PopStyleVarV(7) // the float roundings/border above
	imgui.PopStyleColorV(21) // every PushStyleColor above (must match the push count exactly — an extra pop underflows imgui's style stack and trips the VC runtime "assert Size > 0")
}
