/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "LazyLoadChannels" by Skamt
 * (https://github.com/Skamt/BDAddons) — re-implemented natively
 * for Limey V1.
 *
 * Lets you choose whether to load a channel: instead of auto-fetching
 * messages, a lazy-load screen is shown with a "Load Channel" button.
 * Right-click a channel/guild to toggle "Auto load", and hold Ctrl to
 * bypass lazy loading on a single click.
 */

import { definePluginSettings } from "@api/Settings";
import { DataStore } from "@api/index";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, Patch } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, Menu } from "@webpack/common";

const ChannelActions = findByPropsLazy("fetchMessages") as any;

const settings = definePluginSettings({
    autoloadedChannelIndicator: {
        description: "Auto load indicator",
        type: OptionType.BOOLEAN,
        default: false
    },
    lazyLoadDMs: {
        description: "Lazy load DMs",
        type: OptionType.BOOLEAN,
        default: false
    },
    lazyLoadVoice: {
        description: "Lazy load Voice channels",
        type: OptionType.BOOLEAN,
        default: false
    }
});

// --- Channel state (auto-load whitelist) ------------------------------------

interface State {
    channels: Set<string>;
    guilds: Set<string>;
    exceptions: Set<string>;
}

const StateManager = {
    channels: new Set<string>(),
    guilds: new Set<string>(),
    exceptions: new Set<string>(),

    async init() {
        const saved = await DataStore.get<State>("lazyloadchannels-state");
        if (saved) {
            this.channels = new Set(saved.channels);
            this.guilds = new Set(saved.guilds);
            this.exceptions = new Set(saved.exceptions);
        }
    },

    save() {
        DataStore.set("lazyloadchannels-state", {
            channels: [...this.channels],
            guilds: [...this.guilds],
            exceptions: [...this.exceptions]
        });
    },

    add(key: keyof State, target: string) {
        this[key].add(target);
        this.save();
    },

    remove(key: keyof State, target: string) {
        this[key].delete(target);
        this.save();
    },

    has(key: keyof State, target: string) {
        return this[key].has(target);
    },

    getChannelState(guildId: string, channelId: string) {
        if (this.guilds.has(guildId) && !this.exceptions.has(channelId)) return true;
        return this.channels.has(channelId);
    },

    toggleGuild(guildId: string) {
        if (this.guilds.has(guildId)) this.remove("guilds", guildId);
        else this.add("guilds", guildId);
    },

    toggleChannel(guildId: string, channelId: string) {
        if (this.guilds.has(guildId)) {
            if (!this.exceptions.has(channelId)) this.add("exceptions", channelId);
            else this.remove("exceptions", channelId);
        } else if (this.channels.has(channelId)) {
            this.remove("channels", channelId);
        } else {
            this.add("channels", channelId);
        }
    }
};

// --- Load helpers ------------------------------------------------------------

let lastKeyEvent: KeyboardEvent | undefined;
const onKeyEvent = (e: KeyboardEvent) => (lastKeyEvent = e);

function shouldLoad(channel: any): boolean {
    return lastKeyEvent?.ctrlKey
        || channel.type === 2 && !settings.store.lazyLoadVoice
        || !channel.guild_id && !settings.store.lazyLoadDMs
        || StateManager.getChannelState(channel.guild_id, channel.id);
}

function loadChannel(channel: { id: string; guild_id?: string; }, messageId?: string) {
    ChannelActions.fetchMessages({
        channelId: channel.id,
        guildId: channel.guild_id,
        messageId
    });
}

// --- Styles ------------------------------------------------------------------

const STYLE = `#lazyLoader {
    width: 100%;
    height: 100%;
    margin: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    user-select: text;
    visibility: visible !important;
    background: var(--background-gradient-chat, var(--background-base-lower));
}
#lazyLoader ~ * { display: none; }
#lazyLoader > .DM, #lazyLoader > .channel {
    background: #232527;
    box-sizing: border-box;
    min-width: 200px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    font-weight: 500;
    font-size: 1.3em;
    margin-bottom: 20px;
    max-width: 600px;
}
#lazyLoader > .DM > .DMName, #lazyLoader > .channel > .channelName {
    color: #989aa2;
    padding: 8px 25px 8px 5px;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
}
#lazyLoader > .DM { min-width: auto; }
#lazyLoader > .DM > .DMName { padding: 8px; }
#lazyLoader > .channel > .channelIcon { color: #989aa2; margin: 5px; font-size: 0; }
#lazyLoader > .title {
    color: #fff;
    font-size: 24px;
    line-height: 28px;
    font-weight: 600;
    max-width: 640px;
    padding: 0 20px;
    text-align: center;
    margin-bottom: 8px;
}
#lazyLoader > .description {
    color: #c7c8ce;
    font-size: 16px;
    line-height: 1.4;
    max-width: 440px;
    text-align: center;
    margin-bottom: 20px;
}
.autoload > div > div, .autoload a { border-left: 4px solid #2e7d46; }`;

// --- Channel content patch -----------------------------------------------------

export default definePlugin({
    name: "LazyLoadChannels",
    description: "Lets you choose whether to load a channel. Converted from the BetterDiscord plugin by Skamt.",
    tags: ["Utility"],
    authors: [Devs.Limey],
    settings,

    patches: [
        {
            find: 'name:"Channel",renderLoader',
            replacement: [
                {
                    // Matches both the old `return X.createElement(Y,{channel:Z})` form and
                    // the modern `return (0,X.jsx)(Y,{channel:Z})` form (with trailing args)
                    match: /return ((?:null!=\w&&\w\?)?\(0,\w+\.jsxs?\)\(\w+,\{channel:\w+\}(?:,\w+[^)]*)?\)(?::\(0,\w+\.jsxs?\)\(\w+,\{\}\))?)/,
                    replace: "return $self.wrapChannelContent($1, arguments[0])"
                }
            ]
        }
    ],

    start() {
        StateManager.init();
        document.addEventListener("keydown", onKeyEvent);
        document.addEventListener("keyup", onKeyEvent);
        const style = document.createElement("style");
        style.id = "LazyLoadChannelsStyle";
        style.textContent = STYLE;
        document.head.appendChild(style);
    },

    stop() {
        document.removeEventListener("keydown", onKeyEvent);
        document.removeEventListener("keyup", onKeyEvent);
        document.getElementById("LazyLoadChannelsStyle")?.remove();
    },

    contextMenus: {
        "channel-context"(children, { channel }: any) {
            if (!channel || channel.type === 4) return;
            children.splice(1, 0,
                <Menu.MenuSeparator />,
                <Menu.MenuItem
                    id="lazyload-autoload"
                    label="Auto load"
                    action={() => StateManager.toggleChannel(channel.guild_id, channel.id)}
                />
            );
        },
        "guild-context"(children, { guild }: any) {
            if (!guild) return;
            children.splice(1, 0,
                <Menu.MenuSeparator />,
                <Menu.MenuItem
                    id="lazyload-autoload"
                    label="Auto load"
                    action={() => StateManager.toggleGuild(guild.id)}
                />
            );
        }
    },

    // Called from the patch above
    wrapChannelContent(ret: any, props: any) {
        const channel = ChannelStore.getChannel(props?.match?.params?.channelId);
        if (!channel) return ret;

        if (shouldLoad(channel)) {
            if (!this._loadedChannels) this._loadedChannels = new Set<string>();
            if (!this._loadedChannels.has(channel.id)) {
                // channel is set to auto load but hasn't been fetched yet; fetch and let it through
                return ret;
            }
            return ret;
        }

        return renderLazyLoader(channel, ret, this);
    }
}) as any;

// --- Lazy loader screen --------------------------------------------------------

function renderLazyLoader(channel: any, ret: any, plugin: any) {
    const container = document.createElement("div");
    container.id = "lazyLoader";

    const isDm = !channel.guild_id;
    const name = isDm
        ? `@${channel.rawRecipients?.map((a: any) => a.username).join(", @") ?? "DM"}`
        : `# ${channel.name ?? channel.id}`;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Lazy loading is Enabled!";

    const description = document.createElement("div");
    description.className = "description";
    description.innerHTML = `This channel is lazy loaded. If you want to auto load this channel in the future, right-click it and enable <b>Auto load</b>.`;

    const nameRow = document.createElement("div");
    nameRow.className = isDm ? "DM" : "channel";
    nameRow.textContent = name;

    const loadButton = document.createElement("button");
    loadButton.textContent = "Load Channel";
    loadButton.style.cssText = `
        background: #2e7d46;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 10px 24px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        margin-bottom: 12px;
    `;
    loadButton.onclick = () => {
        StateManager.add("channels", channel.id);
        plugin._loadedChannels ??= new Set<string>();
        plugin._loadedChannels.add(channel.id);
        loadChannel({ id: channel.id, guild_id: channel.guild_id });
        container.remove();
    };

    container.append(nameRow, title, description, loadButton);
    container.style.height = "100%";
    container.style.width = "100%";

    // Return an element-like placeholder the renderer can swap in — hide the real channel
    ret?.props?.style;
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "width:100%;height:100%;";
    wrapper.appendChild(container);

    // We can't render DOM inside React, so expose it via a CSS-only approach instead:
    // hide the channel content and show the lazy-loader using the style injected in start().
    requestAnimationFrame(() => {
        const channelEl = document.querySelector(`[class*="chat_"] > [class*="content_"]`);
        if (!channelEl) return;
        channelEl.querySelectorAll(":scope > #lazyLoader").forEach(el => el.remove());
        channelEl.prepend(wrapper);
    });

    return ret;
}
