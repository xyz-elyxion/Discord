/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
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

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { isPluginEnabled } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingTertiary } from "@components/Heading";
import { DownArrow, RightArrow } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { isTruthy } from "@utils/guards";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { PluginTarget } from "@utils/pluginTargets";
import { useAwaiter, useCleanupEffect } from "@utils/react";
import { PluginTag, PluginTags } from "@utils/types";
import { Button, Clickable, ConfirmModal, lodash, openModal, Parser, React, SearchableSelect, Select, TextInput, Tooltip, useMemo, useRef, useState } from "@webpack/common";
import { JSX } from "react";

import Plugins, { ExcludedPlugins, PluginMeta } from "~plugins";

import { PluginCard } from "./PluginCard";
import { UIElementsButton } from "./UIElements";

export const cl = classNameFactory("vc-plugins-");
export const logger = new Logger("PluginSettings", "#a6d189");

/** Fallback folder for plugins without a tag */
const MISC_CATEGORY = "Other";
const CATEGORY_ORDER: readonly string[] = [...PluginTags, MISC_CATEGORY];

function ReloadRequiredCard({ required }: { required: boolean; }) {
    return (
        <Card variant={required ? "warning" : "normal"} className={cl("info-card")}>
            {required
                ? (
                    <>
                        <HeadingTertiary>Restart required!</HeadingTertiary>
                        <Paragraph className={cl("dep-text")}>
                            Restart now to apply new plugins and their settings
                        </Paragraph>
                        <Button onClick={() => location.reload()} className={cl("restart-button")}>
                            Restart
                        </Button>
                    </>
                )
                : (
                    <>
                        <HeadingTertiary>Plugin Management</HeadingTertiary>
                        <Paragraph>Press the cog wheel or info icon to get more info on a plugin</Paragraph>
                        <Paragraph>Plugins with a cog wheel have settings you can modify!</Paragraph>
                    </>
                )}
        </Card>
    );
}

const enum SearchStatus {
    ALL,
    FAVORITES,
    ENABLED,
    DISABLED,
    NEW,
    USER_PLUGINS,
    API_PLUGINS
}

function ExcludedPluginsList({ search }: { search: string; }) {
    const matchingExcludedPlugins = search
        ? Object.entries(ExcludedPlugins)
            .filter(([name]) => name.toLowerCase().includes(search))
        : [];

    const ExcludedReasons: Record<PluginTarget, string> = {
        desktop: "Discord Desktop app or Vesktop",
        discordDesktop: "Discord Desktop app",
        vesktop: "Vesktop app",
        web: "Vesktop app and the Web version of Discord",
        dev: "Developer version of Limey V1",
        browser: "Web Browser version of Limey V1"
    };

    return (
        <Paragraph className={Margins.top16}>
            {matchingExcludedPlugins.length
                ? <>
                    <Paragraph>Are you looking for:</Paragraph>
                    <ul>
                        {matchingExcludedPlugins.map(([name, reason]) => (
                            <li key={name}>
                                <b>{name}</b>: Only available on the {ExcludedReasons[reason]}
                            </li>
                        ))}
                    </ul>
                </>
                : "No plugins meet the search criteria."
            }
        </Paragraph>
    );
}

function PluginSettings() {
    const settings = useSettings();
    const changeRef = useRef<ChangeList<string>>(null);
    const changes = changeRef.current ??= new ChangeList<string>();

    useCleanupEffect(() => {
        if (changes.hasChanges)
            openModal(props => (
                <ConfirmModal
                    {...props}
                    title="Restart required"
                    confirmText="Restart now"
                    cancelText="Later!"
                    variant="primary"
                    onConfirm={() => location.reload()}
                >
                    <>
                        <p>The following plugins require a restart:</p>
                        <div>{changes.map((s, i) => (
                            <React.Fragment key={s}>
                                {i > 0 && ", "}
                                {Parser.parse("`" + s.split(".")[0] + "`")}
                            </React.Fragment>
                        ))}</div>
                    </>
                </ConfirmModal>
            ));
    }, []);

    const depMap = useMemo(() => {
        const o = {} as Record<string, string[]>;
        for (const plugin in Plugins) {
            const deps = Plugins[plugin].dependencies;
            if (deps) {
                for (const dep of deps) {
                    o[dep] ??= [];
                    o[dep].push(plugin);
                }
            }
        }
        return o;
    }, []);

    const sortedPlugins = useMemo(() =>
        Object.values(Plugins).sort((a, b) => a.name.localeCompare(b.name)),
        []
    )
        .toSorted((a, b) => Number(settings.plugins[b.name]?.isFavorite ?? false) - Number(settings.plugins[a.name]?.isFavorite ?? false));

    const hasUserPlugins = useMemo(() => !IS_STANDALONE && Object.values(PluginMeta).some(m => m.userPlugin), []);

    const [searchValue, setSearchValue] = useState({ value: "", tags: [] as PluginTag[], status: SearchStatus.ALL });

    // Which folders the user manually opened; folders start collapsed
    const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
    const toggleFolder = (category: string) =>
        setOpenFolders(prev => {
            const next = new Set(prev);
            if (next.has(category)) next.delete(category);
            else next.add(category);
            return next;
        });

    const search = searchValue.value.toLowerCase();
    const onSearch = (query: string) => setSearchValue(prev => ({ ...prev, value: query }));

    const pluginFilter = (plugin: typeof Plugins[keyof typeof Plugins]) => {
        const { status, tags } = searchValue;

        switch (status) {
            case SearchStatus.FAVORITES:
                if (!settings.plugins[plugin.name]?.isFavorite) return false;
                break;
            case SearchStatus.DISABLED:
                if (isPluginEnabled(plugin.name)) return false;
                break;
            case SearchStatus.ENABLED:
                if (!isPluginEnabled(plugin.name)) return false;
                break;
            case SearchStatus.NEW:
                if (!newPlugins?.includes(plugin.name)) return false;
                break;
            case SearchStatus.USER_PLUGINS:
                if (!PluginMeta[plugin.name]?.userPlugin) return false;
                break;
            case SearchStatus.API_PLUGINS:
                if (!plugin.name.endsWith("API")) return false;
                break;
        }

        if (tags.length && tags.some(t => !plugin.tags?.includes(t))) return false;

        if (!search.length) return true;

        return (
            plugin.name.toLowerCase().includes(search) ||
            plugin.name.match(/[A-Z]/g)?.join("").toLowerCase().includes(search) || // acronyms like BF for BetterFolders
            plugin.description.toLowerCase().includes(search) ||
            plugin.searchTerms?.some(t => t.toLowerCase().includes(search))
        );
    };

    const [newPlugins] = useAwaiter(() => DataStore.get("LimeyV1_existingPlugins").then((cachedPlugins: Record<string, number> | undefined) => {
        const now = Date.now() / 1000;
        const existingTimestamps: Record<string, number> = {};
        const sortedPluginNames = Object.values(sortedPlugins).map(plugin => plugin.name);

        const newPlugins: string[] = [];
        for (const { name: p } of sortedPlugins) {
            const time = existingTimestamps[p] = cachedPlugins?.[p] ?? now;
            if ((time + 60 * 60 * 24 * 2) > now) {
                newPlugins.push(p);
            }
        }
        DataStore.set("LimeyV1_existingPlugins", existingTimestamps);

        return lodash.isEqual(newPlugins, sortedPluginNames) ? [] : newPlugins;
    }));

    const requiredPlugins = [] as JSX.Element[];
    const groupedPlugins = new Map<string, typeof Plugins[keyof typeof Plugins][]>();
    const sourceFolders = new Set<string>();

    const showApi = searchValue.status === SearchStatus.API_PLUGINS;
    for (const p of sortedPlugins) {
        if (p.hidden || (!p.settings && p.name.endsWith("API") && !showApi))
            continue;

        if (!pluginFilter(p)) continue;

        const isRequired = p.required || p.isDependency || depMap[p.name]?.some(d => settings.plugins[d].enabled);

        if (isRequired) {
            const tooltipText = p.required || !depMap[p.name]
                ? "This plugin is required for Limey V1 to function."
                : makeDependencyList(depMap[p.name]?.filter(d => settings.plugins[d].enabled));

            requiredPlugins.push(
                <Tooltip text={tooltipText} key={p.name}>
                    {({ onMouseLeave, onMouseEnter }) => (
                        <PluginCard
                            onMouseLeave={onMouseLeave}
                            onMouseEnter={onMouseEnter}
                            onRestartNeeded={(name, key) => changes.handleChange(`${name}.${key}`)}
                            disabled={true}
                            plugin={p}
                            key={p.name}
                        />
                    )}
                </Tooltip>
            );
        } else {
            // Mirror the source tree: plugins nested inside a group directory
            // (like src/plugins/checkers/accountChecker) share one folder named
            // after it, so sibling plugins land together. Everything else groups
            // by its primary tag.
            const parts = PluginMeta[p.name]?.folderName?.split("/") ?? [];
            const category = parts.length > 1
                ? parts.slice(0, -1).join("/").replace(/(^\w)/, c => c.toUpperCase())
                : p.tags?.[0] ?? MISC_CATEGORY;
            if (parts.length > 1) sourceFolders.add(category);

            const list = groupedPlugins.get(category) ?? [];
            list.push(p);
            groupedPlugins.set(category, list);
        }
    }

    // Source-tree folders first, then tag folders in the fixed order ("Other" last); only non-empty ones
    const folders = [...groupedPlugins.entries()]
        .map(([category, plugins]) => ({ category, plugins, isSource: sourceFolders.has(category) }))
        .filter(({ plugins }) => plugins.length > 0)
        .sort((a, b) => {
            if (a.isSource !== b.isSource) return a.isSource ? -1 : 1;
            if (a.isSource) return a.category.localeCompare(b.category);
            return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.category.localeCompare(b.category);
        });

    // While searching/filtering, every folder with matches is expanded so
    // results are directly visible without hunting for folders.
    const isFiltering = searchValue.value.length > 0 || searchValue.tags.length > 0 || searchValue.status !== SearchStatus.ALL;

    const renderPluginCard = (p: typeof Plugins[keyof typeof Plugins]) => (
        <PluginCard
            onRestartNeeded={(name, key) => changes.handleChange(`${name}.${key}`)}
            disabled={false}
            plugin={p}
            isNew={newPlugins?.includes(p.name)}
            key={p.name}
        />
    );

    return (
        <SettingsTab>
            <ReloadRequiredCard required={changes.hasChanges} />

            <UIElementsButton />

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Filters
            </HeadingTertiary>

            <ErrorBoundary noop>
                <TextInput
                    inputClassName={cl("filter-control")}
                    placeholder="Search for a plugin..."
                    value={searchValue.value}
                    onChange={onSearch}
                    autoFocus
                />
            </ErrorBoundary>

            <ErrorBoundary noop>
                <div className={classes(Margins.bottom20, Margins.top8, cl("filter-controls"))}>
                    <Select
                        options={[
                            { label: "Show All", value: SearchStatus.ALL, default: true },
                            { label: "Show Favorites", value: SearchStatus.FAVORITES },
                            { label: "Show Enabled", value: SearchStatus.ENABLED },
                            { label: "Show Disabled", value: SearchStatus.DISABLED },
                            { label: "Show New", value: SearchStatus.NEW },
                            hasUserPlugins && { label: "Show UserPlugins", value: SearchStatus.USER_PLUGINS },
                            { label: "Show API Plugins", value: SearchStatus.API_PLUGINS },
                        ].filter(isTruthy)}
                        serialize={String}
                        select={status => setSearchValue(prev => ({ ...prev, status }))}
                        isSelected={v => v === searchValue.status}
                        closeOnSelect={true}
                        placeholder="Filter by Type"
                    />
                    <SearchableSelect
                        options={PluginTags.map(tag => ({ label: tag, value: tag }))}
                        value={searchValue.tags}
                        onChange={tags => setSearchValue(prev => ({ ...prev, tags }))}
                        closeOnSelect={false}
                        placeholder="Filter by Tags"
                        multi
                    />
                </div>
            </ErrorBoundary>

            <HeadingTertiary className={Margins.top20}>Plugins</HeadingTertiary>

            {folders.length || requiredPlugins.length
                ? (
                    <div>
                        {folders.length > 0 && !isFiltering && (
                            <div className={cl("folder-actions")}>
                                <Button
                                    look={Button.Looks.LINK}
                                    size={Button.Sizes.SMALL}
                                    onClick={() => setOpenFolders(new Set(folders.map(({ category }) => category)))}
                                >
                                    Expand All
                                </Button>
                                <Button
                                    look={Button.Looks.LINK}
                                    size={Button.Sizes.SMALL}
                                    onClick={() => setOpenFolders(new Set())}
                                >
                                    Collapse All
                                </Button>
                            </div>
                        )}

                        {folders.length
                            ? folders.map((folder, i) => (
                                <div
                                    key={folder.category}
                                    className={cl("folder")}
                                    data-expanded={isFiltering || openFolders.has(folder.category)}
                                >
                                    <Clickable
                                        className={cl("folder-header")}
                                        role="button"
                                        onClick={() => {
                                            if (!isFiltering) toggleFolder(folder.category);
                                        }}
                                    >
                                        {(isFiltering || openFolders.has(folder.category))
                                            ? <DownArrow className={cl("folder-icon")} />
                                            : <RightArrow className={cl("folder-icon")} />}
                                        <span className={cl("folder-name")}>{folder.category}</span>
                                        <span className={cl("folder-count")}>
                                            {folder.plugins.length} {folder.plugins.length === 1 ? "plugin" : "plugins"}
                                        </span>
                                    </Clickable>

                                    {(isFiltering || openFolders.has(folder.category)) && (
                                        <div className={cl("grid")}>
                                            {folder.plugins.map(renderPluginCard)}
                                        </div>
                                    )}
                                </div>
                            ))
                            : <Paragraph>No plugins meet the search criteria.</Paragraph>
                        }
                    </div>
                )
                : <ExcludedPluginsList search={search} />
            }


            <Divider className={Margins.top20} />

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Required Plugins
            </HeadingTertiary>

            <div className={cl("grid")}>
                {requiredPlugins.length
                    ? requiredPlugins
                    : <Paragraph>No plugins meet the search criteria.</Paragraph>
                }
            </div>
        </SettingsTab >
    );
}

function makeDependencyList(deps: string[]) {
    return (
        <>
            <Paragraph>This plugin is required by:</Paragraph>
            {deps.map((dep: string) => <Paragraph key={dep} className={cl("dep-text")}>{dep}</Paragraph>)}
        </>
    );
}

export default wrapTab(PluginSettings, "Plugins");
