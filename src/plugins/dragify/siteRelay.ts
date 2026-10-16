/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Sharded for plugin-internal imports: the implementation moved to the public
// DragifySite API so every plugin can drive the cross-platform handoff.
export * from "@api/DragifySite/relay";
