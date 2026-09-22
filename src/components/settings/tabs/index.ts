/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

export * from "./BaseTab";
export { default as LimeyV1Tab } from "./limeyV1";
export { default as PatchHelperTab } from "./patchHelper";
export { default as PluginsTab } from "./plugins";
export { openContributorModal } from "./plugins/ContributorModal";
export { openPluginModal } from "./plugins/PluginModal";
export { default as BackupAndRestoreTab } from "./sync/BackupAndRestoreTab";
export { default as CloudTab } from "./sync/CloudTab";
export { default as ThemesTab } from "./themes";
export { default as UpdaterTab } from "./updater";
