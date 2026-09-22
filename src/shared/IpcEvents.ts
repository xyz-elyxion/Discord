/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2023 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

export const enum IpcEvents {
    INIT_FILE_WATCHERS = "LimeyV1InitFileWatchers",

    OPEN_QUICKCSS = "LimeyV1OpenQuickCss",
    GET_QUICK_CSS = "LimeyV1GetQuickCss",
    SET_QUICK_CSS = "LimeyV1SetQuickCss",
    QUICK_CSS_UPDATE = "LimeyV1QuickCssUpdate",

    GET_SETTINGS = "LimeyV1GetSettings",
    SET_SETTINGS = "LimeyV1SetSettings",

    GET_THEMES_LIST = "LimeyV1GetThemesList",
    GET_THEME_SYSTEM_VALUES = "LimeyV1GetThemeSystemValues",

    OPEN_EXTERNAL = "LimeyV1OpenExternal",
    OPEN_SETTINGS_FOLDER = "LimeyV1OpenSettingsFolder",

    GET_UPDATES = "LimeyV1GetUpdates",
    GET_REPO = "LimeyV1GetRepo",
    UPDATE = "LimeyV1Update",
    BUILD = "LimeyV1Build",

    OPEN_MONACO_EDITOR = "LimeyV1OpenMonacoEditor",
    GET_MONACO_THEME = "LimeyV1GetMonacoTheme",

    GET_PLUGIN_IPC_METHOD_MAP = "LimeyV1GetPluginIpcMethodMap",

    CSP_IS_DOMAIN_ALLOWED = "LimeyV1CspIsDomainAllowed",
    CSP_REMOVE_OVERRIDE = "LimeyV1CspRemoveOverride",
    CSP_REQUEST_ADD_OVERRIDE = "LimeyV1CspRequestAddOverride",

    GET_RENDERER_CSS = "LimeyV1GetRendererCss",
    RENDERER_CSS_UPDATE = "LimeyV1RendererCssUpdate",
    PRELOAD_GET_RENDERER_JS = "LimeyV1PreloadGetRendererJs",

    SUPPORTS_WINDOWS_MATERIAL = "LimeyV1SupportsWindowsMaterial",
}
